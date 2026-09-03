/**
 * Framework-level constants only.
 *
 * Anything product/organization specific (organization name, app name, resource
 * names, SSM paths, domains, tag *values*) lives in the per-environment YAML under
 * `env/` so this project can be dropped into any account/organization without code
 * edits. Only the tag *keys* live here, since they are part of the tagging contract
 * this framework applies, not of the adopting organization's identity.
 */
export const CONSTANTS = {
    ENVIRONMENTS: ['dev', 'qa', 'prod'],
    TAG_POLICIES: {
        KEY_NAMES: { PRODUCT: 'Product', OWNER: 'Owner', ENVIRONMENT: 'Environment' },
    },
};
