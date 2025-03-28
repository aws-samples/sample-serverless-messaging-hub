import {CONSTANTS} from "./constants";

export class Validation {

  static stageValidation(env: string) {
    const environments = CONSTANTS.ENVIRONMENTS;

    if (!(environments.includes(env))) {
      throw new Error(`${env} is not a valid environment. Values allowed: ${environments}`)
    }
  }
}
