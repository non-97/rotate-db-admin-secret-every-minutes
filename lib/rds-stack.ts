import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export class RdsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // SSM IAM Role
    const ssmIamRole = new cdk.aws_iam.Role(this, "SSM IAM Role", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore"
        ),
      ],
    });

    // VPC
    const vpc = new cdk.aws_ec2.Vpc(this, "VPC", {
      ipAddresses: cdk.aws_ec2.IpAddresses.cidr("10.0.1.0/24"),
      enableDnsHostnames: true,
      enableDnsSupport: true,
      natGateways: 0,
      maxAzs: 2,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: cdk.aws_ec2.SubnetType.PUBLIC,
          cidrMask: 27,
        },
        {
          name: "Isolated",
          subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 27,
        },
      ],
    });

    // Secrets Manager VPC Endpoint
    new cdk.aws_ec2.InterfaceVpcEndpoint(this, "Secrets Manager VPC Endpoint", {
      vpc,
      service: cdk.aws_ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: vpc.selectSubnets({
        subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED,
      }),
    });

    // Security Group
    const dbSG = new cdk.aws_ec2.SecurityGroup(this, "Security Group of DB", {
      vpc,
    });
    dbSG.addIngressRule(
      cdk.aws_ec2.Peer.ipv4(vpc.vpcCidrBlock),
      cdk.aws_ec2.Port.tcp(3306)
    );

    // EC2 Instance
    new cdk.aws_ec2.Instance(this, "EC2 Instance", {
      instanceType: new cdk.aws_ec2.InstanceType("t3.micro"),
      machineImage: cdk.aws_ec2.MachineImage.latestAmazonLinux({
        generation: cdk.aws_ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      vpc,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: cdk.aws_ec2.BlockDeviceVolume.ebs(8, {
            volumeType: cdk.aws_ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
      propagateTagsToVolumeOnCreation: true,
      vpcSubnets: vpc.selectSubnets({
        subnetType: cdk.aws_ec2.SubnetType.PUBLIC,
      }),
      role: ssmIamRole,
    });

    // RDS Subnet Group
    const subnetGroup = new cdk.aws_rds.SubnetGroup(this, "RDS Subnet Group", {
      vpc,
      description: "RDS Subnet Group",
      subnetGroupName: "rds-subgrp",
      vpcSubnets: {
        subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });

    // Secrets Manager
    const instanceIdentifier = "rds-db-instance";
    const dbAdminSecret = new cdk.aws_secretsmanager.Secret(
      this,
      "DB Admin Secret",
      {
        secretName: `/rds/${instanceIdentifier}/admin`,
        generateSecretString: {
          excludeCharacters: " %+~`#$&*()|[]{}:;<>?!'/@\"\\",
          generateStringKey: "password",
          passwordLength: 32,
          requireEachIncludedType: true,
          secretStringTemplate: '{"username": "admin"}',
        },
      }
    );

    // RDS DB Instance
    const dbInstance = new cdk.aws_rds.DatabaseInstance(
      this,
      "RDS DB Instance",
      {
        engine: cdk.aws_rds.DatabaseInstanceEngine.mysql({
          version: cdk.aws_rds.MysqlEngineVersion.VER_8_0_30,
        }),
        vpc,
        allocatedStorage: 20,
        availabilityZone: vpc.availabilityZones[0],
        backupRetention: cdk.Duration.days(0),
        credentials: cdk.aws_rds.Credentials.fromSecret(dbAdminSecret),
        instanceIdentifier,
        instanceType: cdk.aws_ec2.InstanceType.of(
          cdk.aws_ec2.InstanceClass.T3,
          cdk.aws_ec2.InstanceSize.MICRO
        ),
        multiAz: false,
        publiclyAccessible: false,
        storageEncrypted: true,
        storageType: cdk.aws_rds.StorageType.GP2,
        subnetGroup,
        securityGroups: [dbSG],
      }
    );

    // Set DB Instance storage type to gp3
    const cfnDbInstance = dbInstance.node
      .defaultChild as cdk.aws_rds.CfnDBInstance;
    cfnDbInstance.addPropertyOverride("StorageType", "gp3");

    // Rotation Secret
    new cdk.aws_secretsmanager.SecretRotation(
      this,
      "Rotation DB Admin Secret",
      {
        application:
          cdk.aws_secretsmanager.SecretRotationApplication
            .MYSQL_ROTATION_SINGLE_USER,
        secret: dbAdminSecret,
        target: dbInstance,
        vpc,
        excludeCharacters: dbAdminSecret.excludeCharacters,
        vpcSubnets: vpc.selectSubnets({
          subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED,
        }),
      }
    );

    const cfnDbAdminSecretRotationSchedule = dbAdminSecret.node.tryFindChild(
      "RotationSchedule"
    )?.node.defaultChild as cdk.aws_secretsmanager.CfnRotationSchedule;
    cfnDbAdminSecretRotationSchedule.rotationRules = {
      scheduleExpression: "cron(0 /4 * * ? *)",
    };
  }
}
