/*
 * aws-sigv4.js
 * ============
 * AWS Signature Version 4 request signing, using WebCrypto only.
 *
 * Amazon Polly has no API-key authentication: every request must be signed
 * with an access key and secret. This is the same signing the AWS SDK performs
 * in the browser, implemented directly so the prototype stays dependency-free.
 *
 * The `host` header is included in SignedHeaders because AWS requires it, but
 * it is never set on the fetch — browsers forbid that and supply the correct
 * value themselves, which is what the signature was computed over.
 *
 * Reference: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv4-signing-elements.html
 */
(function (root) {
  'use strict';

  var ALGORITHM = 'AWS4-HMAC-SHA256';
  var encoder = new TextEncoder();

  function subtle() {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error(
        'WebCrypto is unavailable, so AWS requests cannot be signed. ' +
        'This usually means the page is not in a secure context — serve it over ' +
        'HTTPS or from localhost.');
    }
    return window.crypto.subtle;
  }

  function toHex(buffer) {
    var bytes = new Uint8Array(buffer);
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  }

  function sha256Hex(message) {
    var data = typeof message === 'string' ? encoder.encode(message) : message;
    return subtle().digest('SHA-256', data).then(toHex);
  }

  function hmac(key, message) {
    var keyData = typeof key === 'string' ? encoder.encode(key) : key;
    return subtle()
      .importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      .then(function (cryptoKey) {
        return subtle().sign('HMAC', cryptoKey, encoder.encode(message));
      })
      .then(function (signature) { return new Uint8Array(signature); });
  }

  /** kSecret → kDate → kRegion → kService → kSigning */
  function signingKey(secretAccessKey, dateStamp, region, service) {
    return hmac('AWS4' + secretAccessKey, dateStamp)
      .then(function (kDate) { return hmac(kDate, region); })
      .then(function (kRegion) { return hmac(kRegion, service); })
      .then(function (kService) { return hmac(kService, 'aws4_request'); });
  }

  /** ISO8601 basic format, e.g. 20240701T142530Z, plus the YYYYMMDD stamp. */
  function timestamps(date) {
    var iso = date.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
    return { amzDate: iso, dateStamp: iso.slice(0, 8) };
  }

  function encodeRfc3986(value) {
    return encodeURIComponent(value).replace(/[!'()*]/g, function (c) {
      return '%' + c.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function canonicalQuery(params) {
    var keys = Object.keys(params || {}).sort();
    return keys.map(function (key) {
      return encodeRfc3986(key) + '=' + encodeRfc3986(params[key]);
    }).join('&');
  }

  /**
   * Sign a request and return the headers to send.
   *
   * @param {Object} request
   *   {method, url, body, headers, service, region, accessKeyId,
   *    secretAccessKey, sessionToken, date}
   * @returns {Promise<Object>} headers to add to fetch (excluding `host`)
   */
  function sign(request) {
    var url = new URL(request.url);
    var method = (request.method || 'GET').toUpperCase();
    var service = request.service;
    var region = request.region;
    var body = request.body === undefined || request.body === null ? '' : request.body;

    var stamps = timestamps(request.date || new Date());
    var amzDate = stamps.amzDate;
    var dateStamp = stamps.dateStamp;

    // Headers that participate in the signature. Keys are lowercased and the
    // list must be sorted.
    var signed = {
      host: url.host,
      'x-amz-date': amzDate
    };
    Object.keys(request.headers || {}).forEach(function (key) {
      signed[key.toLowerCase()] = String(request.headers[key]).trim();
    });
    if (request.sessionToken) signed['x-amz-security-token'] = request.sessionToken;

    var signedKeys = Object.keys(signed).sort();
    var canonicalHeaders = signedKeys.map(function (key) {
      return key + ':' + signed[key] + '\n';
    }).join('');
    var signedHeaders = signedKeys.join(';');

    var params = {};
    url.searchParams.forEach(function (value, key) { params[key] = value; });

    return sha256Hex(body).then(function (payloadHash) {
      var canonicalRequest = [
        method,
        url.pathname || '/',
        canonicalQuery(params),
        canonicalHeaders,
        signedHeaders,
        payloadHash
      ].join('\n');

      var scope = [dateStamp, region, service, 'aws4_request'].join('/');

      return sha256Hex(canonicalRequest).then(function (hashedRequest) {
        var stringToSign = [ALGORITHM, amzDate, scope, hashedRequest].join('\n');

        return signingKey(request.secretAccessKey, dateStamp, region, service)
          .then(function (key) { return hmac(key, stringToSign); })
          .then(function (signature) {
            // Only signed headers are returned. Sending extra x-amz-* headers
            // would widen the CORS preflight for no benefit here.
            var headers = {
              'X-Amz-Date': amzDate,
              Authorization: ALGORITHM +
                ' Credential=' + request.accessKeyId + '/' + scope +
                ', SignedHeaders=' + signedHeaders +
                ', Signature=' + toHex(signature)
            };
            Object.keys(request.headers || {}).forEach(function (key) {
              headers[key] = request.headers[key];
            });
            if (request.sessionToken) headers['X-Amz-Security-Token'] = request.sessionToken;
            return headers;
          });
      });
    });
  }

  root.AwsSigV4 = {
    sign: sign,
    _sha256Hex: sha256Hex,
    _hmac: hmac,
    _signingKey: signingKey,
    _timestamps: timestamps,
    _canonicalQuery: canonicalQuery
  };
})(window);
