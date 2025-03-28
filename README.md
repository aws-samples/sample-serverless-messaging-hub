# Messaging Component

A CDK TypeScript project that handles messaging infrastructure and components.

## 📝 Description

This project implements messaging infrastructure using AWS CDK with TypeScript. It provides a robust messaging system leveraging AWS services for reliable message processing and delivery.

## 🔧 Prerequisites

- Node.js (v14.x or later)
- AWS CLI configured with appropriate credentials
- AWS CDK CLI installed (`npm install -g aws-cdk`)
- TypeScript knowledge

## ⚙️ Installation

1. Clone the repository
2. Install dependencies:
```bash
npm install
```

## 📁 Project Structure

```
messaging-component/
├── lib/                    # CDK stack definitions
├── bin/                    # CDK app entry point
├── test/                   # Test files
└── cdk.json                # CDK configuration
```

## 🚀 Available Scripts

```bash
# Deploy stack to AWS
cdk deploy -c env=<environment>

# Show changes between deployed stack and current state
cdk diff -c env=<environment>

# Synthesize and print CloudFormation template
cdk synth -c env=<environment>

# Bootstrap sandbox environment
cdk bootstrap -c env=<environment>

```

Note: Replace `<environment>` with your target environment (e.g., sandbox, dev, prod)

## 📦 Deployment

1. Make sure your AWS credentials are configured
2. Deploy to your desired environment:
```bash
cdk deploy -c env=sandbox
```

## 🌍 Environment Context

This project uses CDK context to manage different environments. All CDK commands require the environment context parameter:

```bash
# Example commands
cdk bootstrap -c env=sandbox # Bootstrap sandbox environment
cdk deploy -c env=sandbox    # Deploy to sandbox environment
cdk diff -c env=sandbox      # Check changes in sandbox environment
cdk synth -c env=sandbox     # Synthesize template for sandbox environment
```

## 🏗️ Architecture

![architecture.jpg](lib/utils/architecture.jpg)

Our architecture is built on Amazon EventBridge as the central orchestration component, acting as an enterprise event bus. This service enables us to implement a truly event-driven architecture, where each message can trigger specific workflows based on its nature and destination.

The solution uses Amazon Simple Queue Service (SQS) as a buffer to ensure message durability and handle load spikes. When an event enters the system through EventBridge, the configured rules determine its route: either to the email queue or the SMS queue.

Lambda functions act as event processors, consuming messages from SQS queues and performing necessary transformations. For emails, the corresponding Lambda function retrieves HTML templates stored in Amazon S3 and personalizes them according to the event data. For the personalization process, we use Handlebars, a JavaScript library that provides the necessary power to create semantic templates effectively and without frustration.

For SMS, another Lambda function processes the message content according to the specific requirements of this channel.

Amazon Simple Email Service (SES) handles reliable email delivery, while Amazon Simple Notification Service (SNS) manages SMS sending. Both services provide detailed tracking and metrics capabilities.

Amazon DynamoDB stores critical metadata, such as template configurations, user preferences, and delivery logs, allowing fast and consistent access to this information.

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.

