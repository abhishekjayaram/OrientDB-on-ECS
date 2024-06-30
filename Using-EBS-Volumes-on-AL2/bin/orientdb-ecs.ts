#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { OrientDBEcsStack } from '../lib/orientdb-ecs-stack';

const app = new cdk.App();
new OrientDBEcsStack(app, 'OrientDB-ECS-Stack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
  }
});