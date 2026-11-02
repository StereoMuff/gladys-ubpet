// -----------------------------------------------------------------------------
// App identity the vendor API expects (X-UBT-AppId, the signing key and the
// `product` header). These are the values every copy of the official UPET app
// sends; they identify the app, not the user.
//
// The bundle and its decoder are ported unchanged from the community Home
// Assistant integration (KennebecRiver66/upet-hass-multi-region, secrets.py),
// which keeps the raw values out of the source. Users can override each value
// in the advanced section of the configuration if the vendor rotates them.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

const BUNDLE =
  'ljYo2jp-YYEa8!l@{T_VHwzs' +
  '{0}x|hdY{I(D6@voyjxyRau$' +
  'z)xun8hTMS1aMo4c1O-' +
  'X5lfh1Ql<nOA&)l^Vn3b@EHB' +
  'toX(!f>Rp+L&FnPPA`ODIbRT' +
  'Z{p1-' +
  '*t+#BdE1<ICnsV~j(f@4KmCd' +
  '?0G#*?_+4WnPs#';

// Python's base64.b85decode alphabet (RFC 1924).
const B85 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';

export function b85decode(text) {
  const padding = (5 - (text.length % 5)) % 5;
  const padded = text + '~'.repeat(padding);
  const out = [];
  for (let i = 0; i < padded.length; i += 5) {
    let acc = 0;
    for (const char of padded.slice(i, i + 5)) {
      const digit = B85.indexOf(char);
      if (digit < 0) throw new Error(`bad base85 character ${char}`);
      acc = acc * 85 + digit;
    }
    out.push((acc >>> 24) & 0xff, (acc >>> 16) & 0xff, (acc >>> 8) & 0xff, acc & 0xff);
  }
  return Buffer.from(out.slice(0, out.length - padding));
}

function keystream(length) {
  const seed = createHash('blake2s256').update('up:et:mobile:defaults:v2').digest();
  const chunks = [];
  for (let index = 0; chunks.length * 32 < length; index += 1) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(index);
    chunks.push(
      createHash('blake2s256')
        .update(Buffer.concat([seed, counter]))
        .digest(),
    );
  }
  return Buffer.concat(chunks).subarray(0, length);
}

let cached;

/** @returns {{ APP_ID: string, APP_KEY: string, PRODUCT: string }} */
export function vendorDefaults() {
  if (!cached) {
    const encoded = b85decode(BUNDLE);
    const key = keystream(encoded.length);
    const packed = Buffer.from(encoded.map((byte, i) => byte ^ key[i]));
    const values = JSON.parse(inflateSync(packed).toString('utf8'));
    cached = {
      APP_ID: String(values.APP_ID),
      APP_KEY: String(values.APP_KEY),
      PRODUCT: String(values.PRODUCT),
    };
  }
  return cached;
}
