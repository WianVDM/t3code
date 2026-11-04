// T3 Code ++ owns the t3codeplusplus schemes so stock T3 Code can stay installed beside it.
export const APP_LINK_SCHEME = "t3codeplusplus";
export const APP_LINK_DEVELOPMENT_SCHEME = "t3codeplusplus-dev";

export const appLinkScheme = (development: boolean): string =>
  development ? APP_LINK_DEVELOPMENT_SCHEME : APP_LINK_SCHEME;

// Stock T3 Code and mobile builds still exchange t3code:// links, so parsing accepts both families.
const APP_LINK_PROTOCOL = /^(?:t3codeplusplus|t3code)(?:-[a-z]+)?:$/;

export const isAppLinkProtocol = (protocol: string): boolean => APP_LINK_PROTOCOL.test(protocol);
