/**
 * Database name of a Mongo URI, read the same way by jest globalSetup and globalTeardown.
 * A regex, not `new URL`: the WHATWG parser rejects valid multi-host Mongo URIs.
 * @param {string|undefined} uri - the resolved config.db.uri
 * @returns {string} the database name, '' when the URI names none
 */
export default (uri) => /^mongodb(?:\+srv)?:\/\/[^/]*\/([^?]*)/.exec(uri ?? '')?.[1] ?? '';
