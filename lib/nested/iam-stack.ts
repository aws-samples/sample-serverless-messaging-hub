import {NestedStack} from "aws-cdk-lib";
import {IamNestedParams} from "../utils/interfaces/general-interfaces";
import {Policies} from "../iam/policies";

export class IamStack extends NestedStack {
    constructor({id, stackAttributes, services}: IamNestedParams) {
        super(stackAttributes.scope, id, stackAttributes.props);

        new Policies(this, 'PoliciesStackConstruct',
            services);
    }
}
