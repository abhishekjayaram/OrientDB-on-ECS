import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as autoscaling from "aws-cdk-lib/aws-autoscaling"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as ecs from "aws-cdk-lib/aws-ecs"
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2"
import * as iam from "aws-cdk-lib/aws-iam"
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager"

export class OrientDBEcsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpcId = process.env.VPC_ID || "";
    const subnetIds = process.env.SUBNET_IDS?.split(",") || [];
    const securityGroupId = process.env.SG_ID || "";
    const sshKeyName = process.env.SSH_KEY_NAME || ""
    const ec2InstanceType = process.env.EC2_INSTANCE_TYPE || ""
    const odbImage = process.env.ORIENTDB_IMAGE || ""
    const odbCpu = Number(process.env.ORIENTDB_CPU) || 2048
    const odbMemory= Number(process.env.ORIENTDB_MEMORY) || 8192
    const odbOptsMemory = process.env.ORIENTDB_OPTS_MEMORY || ""
    const odbRootPassword = process.env.ORIENTDB_ROOT_PASSWORD || ""
    const DATABASE_VOLUME_NAME = 'orientdb-databases-vol';
    const BACKUP_VOLUME_NAME = 'orientdb-backup-vol';

    const vpc = ec2.Vpc.fromVpcAttributes(this, 'VPC', {
      availabilityZones: cdk.Fn.getAzs(),
      vpcId: vpcId,
      publicSubnetIds: subnetIds
    });

    var subnets = []
    for (var i = 0; i < subnetIds.length; i++) {
      subnets.push(ec2.Subnet.fromSubnetId(this, 'PublicSubnet' + String(i), subnetIds[i]))
    }

    const securityGroup = ec2.SecurityGroup.fromSecurityGroupId(this, 'SecurityGroup', securityGroupId)

    const orientRootPasswdSecret = new secretsmanager.Secret(this, 'OrientRootPassword', {
      secretName: 'OrientRootPassword',
      secretObjectValue: {
        password: cdk.SecretValue.unsafePlainText(odbRootPassword),
      },
    });

    const cluster = new ecs.Cluster(this, 'OrientDB-Cluster', {
      vpc: vpc,
      clusterName: "OrientDB-Cluster"
    });

    const ec2RexrayEbsPolicy = new iam.Policy(this, 'ec2-rexray-ebs-policy', {
      policyName: 'ECS-REXRay-EBS',
      statements: [
        iam.PolicyStatement.fromJson({
          Effect: 'Allow',
          Action: [
            'ec2:AttachVolume',
            'ec2:CreateVolume',
            'ec2:CreateSnapshot',
            'ec2:CreateTags',
            'ec2:DeleteVolume',
            'ec2:DeleteSnapshot',
            'ec2:DescribeAvailabilityZones',
            'ec2:DescribeInstances',
            'ec2:DescribeVolumes',
            'ec2:DescribeVolumeAttribute',
            'ec2:DescribeVolumeStatus',
            'ec2:DescribeSnapshots',
            'ec2:CopySnapshot',
            'ec2:DescribeSnapshotAttribute',
            'ec2:DetachVolume',
            'ec2:ModifySnapshotAttribute',
            'ec2:ModifyVolumeAttribute',
            'ec2:DescribeTags',
          ],
          Resource: '*',
        }),
      ],
    });

    const executionPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "kms:Decrypt",
        "ssm:GetParameters",
        "secretsmanager:GetSecretValue"
      ],
      resources: [
        orientRootPasswdSecret.secretArn
      ]
    })

    const autoScalingGroup = new autoscaling.AutoScalingGroup(this, 'OrientDB-ASG', {
      vpc: vpc,
      instanceType: new ec2.InstanceType(ec2InstanceType),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2(),
      keyName: sshKeyName,
      desiredCapacity: 1,
      minCapacity:1,
      maxCapacity:1,
      vpcSubnets: {
        subnets: subnets
      },
      securityGroup: securityGroup
    });

    const userdata = `#!/bin/bash\ndocker plugin install rexray/ebs REXRAY_PREEMPT=true EBS_REGION=${this.region} --grant-all-permissions`

    autoScalingGroup.addUserData(userdata)
    
    autoScalingGroup.role.attachInlinePolicy(ec2RexrayEbsPolicy);

    const capacityProvider = new ecs.AsgCapacityProvider(this, 'AsgCapacityProvider', {
      autoScalingGroup,
      // enableManagedScaling: false,
      // enableManagedTerminationProtection: false
    });

    cluster.addAsgCapacityProvider(capacityProvider);

    const taskDefinition = new ecs.Ec2TaskDefinition(this, 'OrientDB', {
      family: 'OrientDB',
      networkMode: ecs.NetworkMode.BRIDGE
    });

    const myContainer: ecs.ContainerDefinition = taskDefinition.addContainer('OrientDB-ECS', {
      image: ecs.ContainerImage.fromRegistry(odbImage),
      cpu: odbCpu,
      memoryLimitMiB: odbMemory,
      portMappings: [
        {
          containerPort: 2424,
          hostPort: 2424,
          protocol: ecs.Protocol.TCP
        },
        {
          containerPort: 2480,
          hostPort: 2480,
          protocol: ecs.Protocol.TCP
        }
      ],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'OrientDB-ECS',
        logRetention: cdk.aws_logs.RetentionDays.ONE_MONTH
      }
      ),
      essential: true,
      environment : {
        'ORIENTDB_OPTS_MEMORY': odbOptsMemory // Heap memory options
      },
      secrets : {
        'ORIENTDB_ROOT_PASSWORD' : ecs.Secret.fromSecretsManager(orientRootPasswdSecret, 'password')
      }
    });

    taskDefinition.addVolume({
      name: DATABASE_VOLUME_NAME,
      dockerVolumeConfiguration: {
        autoprovision: true,
        scope: ecs.Scope.SHARED,
        driver: 'rexray/ebs',
        driverOpts: {
          volumetype: "gp3",
          size: "100"
        }
      },
    });
    myContainer.addMountPoints({
      sourceVolume: DATABASE_VOLUME_NAME,
      containerPath: '/orientdb/databases',
      readOnly: false,
    });

    taskDefinition.addVolume({
      name: BACKUP_VOLUME_NAME,
      dockerVolumeConfiguration: {
        autoprovision: false,
        scope: ecs.Scope.SHARED,
        driver: 'rexray/ebs',
        driverOpts: {
          volumetype: "gp3",
          size: "100"
        }
      },
    });
    myContainer.addMountPoints({
      sourceVolume: BACKUP_VOLUME_NAME,
      containerPath: '/orientdb/backup',
      readOnly: false,
    });

    taskDefinition.addToExecutionRolePolicy(executionPolicy)
    
    const Service = new ecs.Ec2Service(this, 'OrientDB-Service', { 
      cluster: cluster,
      taskDefinition: taskDefinition,
      serviceName: 'OrientDB',
      circuitBreaker: { rollback: true },
      desiredCount: 1,
      minHealthyPercent: 0
    });
    Service.node.addDependency(capacityProvider)

  }
}
