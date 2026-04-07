const config = {
  audit: {
    activated: true,
    enabled: true,
    ttlDays: 90,
    captureIp: true,
    captureUserAgent: true,
    // Route segment → entity type map (merged from all module configs)
    routeTypeMap: {},
  },
};

export default config;
