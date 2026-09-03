import { NestedStack } from 'aws-cdk-lib';
import { AuditNestedParams } from '../utils/interfaces/general-interfaces';
import { Audit } from '../audit/audit';

export class AuditStack extends NestedStack {
    public readonly audit: Audit;

    constructor({ id, stackAttributes }: AuditNestedParams) {
        super(stackAttributes.scope, id, stackAttributes.props);

        this.audit = new Audit(
            this,
            'AuditConstruct',
            stackAttributes.environmentVariables,
            stackAttributes.prefixResources,
            stackAttributes.environmentVariables.region,
        );
    }
}
