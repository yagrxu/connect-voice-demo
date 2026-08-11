'use strict';
// ACM certificate for the custom domain. CloudFront requires its certificate
// to live in us-east-1, regardless of where the rest of the stack runs — so
// this is a separate stack pinned to us-east-1. It is DNS-validated against the
// Route 53 hosted zone (fully automatic, no manual validation records).
const { Stack } = require('aws-cdk-lib');
const acm = require('aws-cdk-lib/aws-certificatemanager');
const route53 = require('aws-cdk-lib/aws-route53');

class CertStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const { domainName, hostedZoneId, zoneName } = props;

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId,
      zoneName,
    });

    this.certificate = new acm.Certificate(this, 'Cert', {
      domainName,
      validation: acm.CertificateValidation.fromDns(zone),
    });
  }
}

module.exports = { CertStack };
