// Template identity used by both the builder (e2b template build) and by
// consumers who call `Sandbox.create(CLAWD_TEMPLATE_NAME)`.
//
// The concrete template is defined in ./Dockerfile + ./e2b.toml. When the e2b
// TS SDK exposes its `Template()` builder API in a stable release we can
// re-introduce a programmatic builder here; for now the Dockerfile is the
// source of truth.
export const CLAWD_TEMPLATE_NAME = 'clawd';
