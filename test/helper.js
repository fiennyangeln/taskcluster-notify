let assert      = require('assert');
let path        = require('path');
let _           = require('lodash');
let mocha       = require('mocha');
let aws         = require('aws-sdk');
let taskcluster = require('taskcluster-client');
let config      = require('typed-env-config');
let testing     = require('taskcluster-lib-testing');
let api         = require('../src/api');
let exchanges   = require('../src/exchanges');
let load        = require('../src/main');

// Load configuration
let cfg = config({profile: 'test'});

let testclients = {
  'test-client': ['*'],
  'test-server': ['*'],
};

// Create and export helper object
let helper = module.exports = {};

// Skip tests if no credentials is configured
if (!cfg.pulse || !cfg.aws) {
  console.log('Skip tests due to missing credentials!');
  process.exit(1);
}

helper.checkSqsMessage = (queueUrl, check) => {
  return helper.sqs.receiveMessage({
    QueueUrl:             queueUrl,
    AttributeNames:       ['ApproximateReceiveCount'],
    MaxNumberOfMessages:  10,
    VisibilityTimeout:    30,
    WaitTimeSeconds:      20,
  }).promise().then(async (resp) => {
    let m = resp.Messages;
    assert.equal(m.length, 1);
    await helper.sqs.deleteMessage({
      QueueUrl:       queueUrl,
      ReceiptHandle:  m[0].ReceiptHandle,
    }).promise();
    check(JSON.parse(m[0].Body));
  });
};

let webServer = null;

// Setup before tests
mocha.before(async () => {
  // Create mock authentication server
  testing.fakeauth.start(testclients);

  helper.publisher = await load('publisher', {profile: 'test', process: 'test'});
  webServer = await load('server', {profile: 'test', process: 'test', publisher: helper.publisher});

  // Create client for working with API
  helper.baseUrl = 'http://localhost:' + webServer.address().port + '/v1';
  let reference = api.reference({baseUrl: helper.baseUrl});
  helper.Notify = taskcluster.createClient(reference);
  helper.notify = new helper.Notify({
    baseUrl: helper.baseUrl,
    credentials: {
      clientId:       'test-client',
      accessToken:    'none',
    },
  });

  // Create client for binding to reference
  let exchangeReference = exchanges.reference({
    exchangePrefix:   cfg.app.exchangePrefix,
    credentials:      cfg.pulse,
  });
  helper.NotifyEvents = taskcluster.createClient(exchangeReference);
  helper.notifyEvents = new helper.NotifyEvents();

  // Create client for listening for irc requests
  helper.sqs = new aws.SQS(cfg.aws);
  helper.sqsQueueUrl = await helper.sqs.createQueue({
    QueueName:  cfg.app.sqsQueueName,
  }).promise().then(req => req.QueueUrl);
  let approxLen = await helper.sqs.getQueueAttributes({
    QueueUrl: helper.sqsQueueUrl,
    AttributeNames: ['ApproximateNumberOfMessages'],
  }).promise().then(req => req.Attributes.ApproximateNumberOfMessages);
  if (approxLen !== '0') {
    console.log(`Detected ${approxLen} messages in irc queue. Purging.`);
    await helper.sqs.purgeQueue({
      QueueUrl: helper.sqsQueueUrl,
    }).promise();
  }

  // Create client for listening for email successes
  helper.emailSqsQueueUrl = await helper.sqs.createQueue({
    QueueName:  'taskcluster-notify-test-emails',
  }).promise().then(req => req.QueueUrl);
  let emailAttr = await helper.sqs.getQueueAttributes({
    QueueUrl: helper.emailSqsQueueUrl,
    AttributeNames: ['ApproximateNumberOfMessages', 'QueueArn'],
  }).promise().then(req => req.Attributes);
  if (emailAttr.ApproximateNumberOfMessages !== '0') {
    console.log(`Detected ${emailAttr.ApproximateNumberOfMessages} messages in email queue. Purging.`);
    await helper.sqs.purgeQueue({
      QueueUrl: helper.emailSqsQueueUrl,
    }).promise();
  }

  // Create client for listening for delivered fake emails
  let sns = new aws.SNS(cfg.aws);
  let snsArn = await sns.createTopic({
    Name: 'taskcluster-notify-test',
  }).promise().then(res => res.TopicArn);
  let subscribed = await sns.listSubscriptionsByTopic({
    TopicArn: snsArn,
  }).promise().then(req => {
    for (let subscription of req.Subscriptions) {
      if (subscription.Endpoint === emailAttr.QueueArn) {
        return true;
      }
    }
    return false;
  });
  if (!subscribed) {
    await sns.subscribe({
      Protocol: 'sqs',
      TopicArn: snsArn,
      Endpoint: emailAttr.QueueArn,
    }).promise();
  }
  // Create queueEvents and Queue client
  helper.queue = new taskcluster.Queue({
    credentials: cfg.taskcluster.credentials,
  });
});

mocha.after(async () => {
  await webServer.terminate();
  testing.fakeauth.stop();
});
