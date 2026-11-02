// -----------------------------------------------------------------------------
// Integration configuration: defaults (mirroring the manifest `config_schema`)
// and normalization of what Gladys sends.
// -----------------------------------------------------------------------------

// Regional API hosts. The UPET app exists in three regional editions with
// separate account databases, so the region is the app edition the account was
// created in, not where the user lives. The MQTT broker is the same host.
export const REGION_BASE_URLS = {
  eu: 'https://apis-eu.airrobo-home.com',
  na: 'https://apis.airrobo-home.com',
  asia: 'https://apis-jp.airrobo-home.com',
  ru: 'https://apis-ru.airrobo-home.com',
  airpet_eu: 'https://apis-eu.ubtrobot.com',
  airpet_na: 'https://apis-na.ubtrobot.com',
  airpet_global: 'https://apis.ubtrobot.com',
};

export const DEFAULT_CONFIG = {
  region: 'eu',
  country: '',
  account: '',
  password: '',
  refresh_interval: 180,
  app_id: '',
  app_key: '',
  product: '',
};

const MIN_REFRESH_SECONDS = 60;
const MAX_REFRESH_SECONDS = 3600;

/** Merge the user config with the defaults and coerce the types. */
export function normalizeConfig(raw = {}) {
  const text = (value) =>
    typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
  const region = Object.hasOwn(REGION_BASE_URLS, raw.region) ? raw.region : DEFAULT_CONFIG.region;
  let refresh = Number(raw.refresh_interval ?? DEFAULT_CONFIG.refresh_interval);
  if (!Number.isFinite(refresh)) refresh = DEFAULT_CONFIG.refresh_interval;
  refresh = Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, Math.round(refresh)));
  return {
    region,
    baseUrl: REGION_BASE_URLS[region],
    country: text(raw.country).toUpperCase(),
    account: text(raw.account),
    // The password is used as typed: no trimming, spaces can be part of it.
    password: typeof raw.password === 'string' ? raw.password : '',
    refresh_interval: refresh,
    app_id: text(raw.app_id),
    app_key: text(raw.app_key),
    product: text(raw.product),
  };
}

/** True when the user filled in what a login needs. */
export function isConfigured(config) {
  return Boolean(config.account && config.password);
}

/** Fingerprint of the fields that need a new cloud session when they change. */
export function sessionKey(config) {
  return JSON.stringify([
    config.baseUrl,
    config.country,
    config.account,
    config.password,
    config.app_id,
    config.app_key,
    config.product,
  ]);
}
