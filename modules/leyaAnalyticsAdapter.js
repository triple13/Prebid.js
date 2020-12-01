import adapter from '../src/AnalyticsAdapter.js';
import CONSTANTS from '../src/constants.json';
import adapterManager from '../src/adapterManager.js';
import includes from 'core-js-pure/features/array/includes.js';

import * as utils from '../src/utils.js';

const DEFAULT_CURRENCY = 'USD';
const analyticsType = 'endpoint';

const {
  EVENTS: {
    AUCTION_INIT,
    AUCTION_END,
    BID_REQUESTED,
    BID_ADJUSTMENT,
    BIDDER_DONE,
    BID_WON,
    BID_RESPONSE
  }
} = CONSTANTS;

const AUCTION_STATUS = {
  'RUNNING': 'running',
  'FINISHED': 'finished'
};
const BIDDER_STATUS = {
  'REQUESTED': 'requested',
  'BID': 'bid',
  'NO_BID': 'noBid',
  'TIMEOUT': 'timeout'
};
const LEYA_EVENTS = {
  'AUCTION': 'a',
  'IMPRESSION': 'i',
  'BID_AFTER_TIMEOUT': 'bat'
};

const CONSENT_STATUS = {
  'NO_CONSENT': 0,
  'CONSENT': 1,
  'SOME_CONSENT': 2,
  'UNDEFINED': 3
};

let initOptions = {};

let auctionCache = {};
let auctionTtl = 60 * 60 * 1000;

/**
 *
 * @param adUnit
 * @returns {boolean}
 */
function isSupportedAdUnit(adUnit) {
  if (!initOptions.adUnits.length) {
    return true;
  }

  return includes(initOptions.adUnits, adUnit);
}

/**
 * Deletes old auctions based on the auction TTL
 */
function deleteOldAuctions() {
  for (let auctionId in auctionCache) {
    let auction = auctionCache[auctionId];
    if (Date.now() - auction.start > auctionTtl) {
      delete auctionCache[auctionId];
    }
  }
}

/**
 *
 * @param args
 * @returns {{id, start, timeout, adUnits: {}}}
 */
function buildAuctionEntity(args) {
  return {
    'id': args.auctionId,
    'start': args.timestamp,
    'timeout': args.timeout,
    'adUnits': {}
  };
}

/**
 * Extracts an AdUnitCode from an object args.adUnitCode
 * @param args
 * @returns {string}
 */
function extractAdUnitCode(args) {
  return args.adUnitCode.toLowerCase();
}

/**
 * Extracts an AdUnit's size from an object args.adUnitCode
 * @param args
 * @returns {Array}
 */
function extractAdUnitSizes(args) {
  let sizes = [];
  if (Array.isArray(args.sizes)) {
    // http://prebid.org/dev-docs/adunit-reference.html
    if (Array.isArray(args.sizes[0])) {
      // may have multiple sizes
      args.sizes.forEach(function (s) {
        sizes.push(s[0] + 'x' + s[1]);
      });
    } else {
      sizes.push(args.sizes[0] + 'x' + args.sizes[1]);
    }
  }
  return sizes;
}

/**
 * Extracts an AdUnit path from an object args.adUnitCode
 * @param args
 * @returns {string}
 */
function extractAdUnitPath(args) {
  return getPrebidAdUnit(args.adUnitCode.toLowerCase()).path;
}

/**
 * Extracts the bidder from an object args.bidder
 * @param args
 * @returns {string}
 */
function extractBidder(args) {
  return args.bidder.toLowerCase();
}

/**
 * Extracts the bidder from an object args.adId
 * @param args
 * @returns {*}
 */
function extractAdId(args) {
  return args.adId.toLowerCase();
}

/**
 *
 * @param auction
 * @param bidRequest
 * @returns {{adUnit: string, start, timeout, finish: number, status: string, bidders: {}}}
 */
function buildAdUnitAuctionEntity(auction, bidRequest) {
  return {
    'adUnit': extractAdUnitCode(bidRequest),
    'adUnitPath': extractAdUnitPath(bidRequest),
    'adUnitSizes': extractAdUnitSizes(bidRequest),
    'start': auction.start,
    'timeout': auction.timeout,
    'finish': 0,
    'status': AUCTION_STATUS.RUNNING,
    'bidders': {}
  };
}

/**
 *
 * @param auction
 * @param bidRequest
 * @returns {{bidder: string, isAfterTimeout: number, start: *|Date|number, finish: number, status: string, cpm: number, size: {width: number, height: number}, mediaType: string, source: string}}
 */
function buildBidderRequest(auction, bidRequest) {
  return {
    'bidder': extractBidder(bidRequest),
    'isAfterTimeout': auction.status === AUCTION_STATUS.FINISHED ? 1 : 0,
    'start': bidRequest.startTime || Date.now(),
    'finish': 0,
    'status': BIDDER_STATUS.REQUESTED,
    'cpm': -1,
    'size': {
      'width': 0,
      'height': 0
    },
    'mediaType': '-',
    'source': bidRequest['source'] || bidRequest['src'] || 'client'
  };
}

/**
 *
 * @param adUnitAuction
 * @param args
 * @returns {{auction: *, adUnit: string, bidder: string, cpm: *, size: {width: number, height: number}, mediaType: string, start: *|number, finish: *|number}}
 */
function buildBidAfterTimeout(adUnitAuction, args) {
  const auction = utils.deepClone(adUnitAuction);
  const bidder = findBidder(auction, args);

  return {
    'auction': auction,
    'adUnit': extractAdUnitCode(args),
    'adUnitPath': extractAdUnitPath(args),
    'bidder': extractBidder(args),
    'cpm': (bidder && bidder.cpm) || args.cpm,
    'size': {
      'width': args.width || 0,
      'height': args.height || 0
    },
    'mediaType': args.mediaType || '-',
    'start': args.requestTimestamp,
    'finish': args.responseTimestamp
  };
}

/**
 *
 * @param adUnitAuction
 * @param args
 * @returns {{isNew: number, auction: *, adUnit: string, bidder: string, cpm: *, size: {width, height}, mediaType}}
 */
function buildImpression(adUnitAuction, args) {
  const auction = utils.deepClone(adUnitAuction);
  const winnerBidder = findBidder(auction, args);

  return {
    'auction': auction,
    'adUnit': extractAdUnitCode(args),
    'adUnitPath': extractAdUnitPath(args),
    'bidder': extractBidder(args),
    'cpm': (winnerBidder && winnerBidder.cpm) || args.cpm,
    'size': {
      'width': args.width,
      'height': args.height
    },
    'mediaType': args.mediaType
  };
}

/**
 * Find bidder in the adunit auction to get the correct cpm afterwards
 * @param auction
 * @param event
 * @returns {*}
 */
function findBidder(auction, event) {
  const bidderCode = extractBidder(event);
  const adId = extractAdId(event);
  return Object.keys(auction.bidders)
  .map(bidderId => auction.bidders[bidderId])
  .find(bidder => bidder.bidder === bidderCode && bidder.adId === adId)
}

/**
 *
 * @param args
 */
function handleAuctionInit(args) {
  auctionCache[args.auctionId] = buildAuctionEntity(args);
  deleteOldAuctions();
}

/**
 *
 * @param bidRequest
 * @returns {{getConsentValue: getConsentValue}}
 * @constructor
 */
function GdprConsent(bidRequest) {
  const vendorData = bidRequest.gdprConsent && bidRequest.gdprConsent.vendorData;

  const purposeConsentsAux = (vendorData && vendorData.purposeConsents) || [];
  const vendorConsentsAux = (vendorData && vendorData.vendorConsents) || [];

  const purposeConsents = Object.keys(purposeConsentsAux).map(key => purposeConsentsAux[key]);
  const vendorConsents = Object.keys(vendorConsentsAux).map(key => vendorConsentsAux[key]);

  function isConsentUndefined() {
    return purposeConsents.length == 0 && vendorConsents.length == 0;
  }

  function isConsentGiven() {
    const notAcceptedAnyPurpose = purposeConsents.every(purpose => purpose === false);
    const notAcceptedAnyVendor = vendorConsents.every(vendor => vendor === false);
    const consentNotGiven = notAcceptedAnyPurpose || notAcceptedAnyVendor;
    return !consentNotGiven;
  }

  function getConsentValue() {
    let consent;
    if (isConsentUndefined()) {
      consent = CONSENT_STATUS.UNDEFINED;
    } else if (isConsentGiven()) {
      consent = CONSENT_STATUS.CONSENT;
    } else {
      consent = CONSENT_STATUS.NO_CONSENT;
    }
    return consent;
  }

  return {
    getConsentValue: getConsentValue
  };
}

/**
 *
 * @param bidRequest
 */
function buildGDPRConsent(bidRequest) {
  return new GdprConsent(bidRequest).getConsentValue();
}

/**
 *
 * @param args
 */
function handleBidRequested(args) {
  let auction = auctionCache[args.auctionId];
  auction['gdpr_consent'] = auction['gdpr_consent'] || buildGDPRConsent(args);

  args.bids.forEach(function (bidRequest) {
    let adUnitCode = extractAdUnitCode(bidRequest);
    let bidder = extractBidder(bidRequest);
    if (!isSupportedAdUnit(adUnitCode)) {
      return;
    }
    auction['adUnits'][adUnitCode] = auction['adUnits'][adUnitCode] || buildAdUnitAuctionEntity(auction, bidRequest);
    let adUnitAuction = auction['adUnits'][adUnitCode];
    adUnitAuction['bidders'][bidder] = adUnitAuction['bidders'][bidder] || buildBidderRequest(auction, bidRequest);
    utils.logMessage(buildBidderRequest(auction, bidRequest))
  });
}

/**
 *
 * @param args
 */
function handleBidResponse(args) {
  let adUnitCode = extractAdUnitCode(args);
  let bidderCode = extractBidder(args);
  let bidder = auctionCache[args.auctionId]['adUnits'][adUnitCode]['bidders'][bidderCode];
  bidder.adId = extractAdId(args);

  if (typeof args.getCpmInNewCurrency === 'function') {
    try {
      bidder.cpm = args.getCpmInNewCurrency(DEFAULT_CURRENCY)
    } catch (error) {
      utils.logWarn('Failed to convert to USD', error)
    }
  }
}

/**
 *
 * @param args
 */
function handleBidAdjustment(args) {
  let adUnitCode = extractAdUnitCode(args);
  let bidder = extractBidder(args);
  if (!isSupportedAdUnit(adUnitCode)) {
    return;
  }

  let adUnitAuction = auctionCache[args.auctionId]['adUnits'][adUnitCode];
  adUnitAuction['id'] = args.auctionId;
  adUnitAuction['gdpr_consent'] = auctionCache[args.auctionId].gdpr_consent;

  if (adUnitAuction.status === AUCTION_STATUS.FINISHED) {
    handleBidAfterTimeout(adUnitAuction, args);
    return;
  }

  let bidderRequest = adUnitAuction['bidders'][bidder];
  if (bidderRequest.cpm < args.cpm) {
    bidderRequest.cpm = args.cpm;
    bidderRequest.finish = args.responseTimestamp;
    bidderRequest.status = args.cpm === 0 ? BIDDER_STATUS.NO_BID : BIDDER_STATUS.BID;
    bidderRequest.size.width = args.width || 0;
    bidderRequest.size.height = args.height || 0;
    bidderRequest.mediaType = args.mediaType || '-';
  }
}

/**
 *
 * @param adUnitAuction
 * @param args
 */
function handleBidAfterTimeout(adUnitAuction, args) {
  let bidder = extractBidder(args);
  let bidderRequest = adUnitAuction['bidders'][bidder];
  let bidAfterTimeout = buildBidAfterTimeout(adUnitAuction, args);

  if (bidAfterTimeout.cpm > bidderRequest.cpm) {
    bidderRequest.cpm = bidAfterTimeout.cpm;
    bidderRequest.isAfterTimeout = 1;
    bidderRequest.finish = bidAfterTimeout.finish;
    bidderRequest.size = bidAfterTimeout.size;
    bidderRequest.mediaType = bidAfterTimeout.mediaType;
    bidderRequest.status = bidAfterTimeout.cpm === 0 ? BIDDER_STATUS.NO_BID : BIDDER_STATUS.BID;
  }

  if (isWantedEvent(LEYA_EVENTS.BID_AFTER_TIMEOUT)) {
    if (window.Leya) {
      window.Leya.Events.Prebid.handleBidAfterTimeoutEvent(bidAfterTimeout)
    } else {
      utils.logError("Can't log event, Leyajs is not defined");
    }
  }
}

/**
 *
 * @param args
 */
function handleBidderDone(args) {
  let auction = auctionCache[args.auctionId];

  args.bids.forEach(function (bidDone) {
    let adUnitCode = extractAdUnitCode(bidDone);
    let bidder = extractBidder(bidDone);
    if (!isSupportedAdUnit(adUnitCode)) {
      return;
    }

    let adUnitAuction = auction['adUnits'][adUnitCode];
    if (adUnitAuction.status === AUCTION_STATUS.FINISHED) {
      return;
    }
    let bidderRequest = adUnitAuction['bidders'][bidder];
    if (bidderRequest.status !== BIDDER_STATUS.REQUESTED) {
      return;
    }

    bidderRequest.finish = Date.now();
    bidderRequest.status = BIDDER_STATUS.NO_BID;
    bidderRequest.cpm = 0;
  });
}

/**
 *
 * @param args
 */
function handleAuctionEnd(args) {
  let auction = auctionCache[args.auctionId];
  if (!auction) {
    utils.logWarn('There is not an auction available in memory for this event', args);
    return;
  }

  if (!Object.keys(auction.adUnits).length) {
    delete auctionCache[args.auctionId];
  }

  let finish = Date.now();
  auction.finish = finish;
  for (let adUnit in auction.adUnits) {
    let adUnitAuction = auction.adUnits[adUnit];
    adUnitAuction.finish = finish;
    adUnitAuction.status = AUCTION_STATUS.FINISHED;

    for (let bidder in adUnitAuction.bidders) {
      let bidderRequest = adUnitAuction.bidders[bidder];
      if (bidderRequest.status !== BIDDER_STATUS.REQUESTED) {
        continue;
      }

      bidderRequest.status = BIDDER_STATUS.TIMEOUT;
    }
  }

  if (isWantedEvent(LEYA_EVENTS.AUCTION)) {
    if (window.Leya) {
      window.Leya.Events.Prebid.handleAuctionEvent(auction);
    } else {
      utils.logError("Can't log event, Leyajs is not defined");
    }
  }
}

/**
 *
 * @param args
 */
function handleBidWon(args) {
  let adUnitCode = extractAdUnitCode(args);
  if (!isSupportedAdUnit(adUnitCode)) {
    return;
  }
  let adUnitAuction = auctionCache[args.auctionId]['adUnits'][adUnitCode];
  adUnitAuction['id'] = args.auctionId;
  adUnitAuction['gdpr_consent'] = auctionCache[args.auctionId]['gdpr_consent'];

  let impression = buildImpression(adUnitAuction, args);

  if (isWantedEvent(LEYA_EVENTS.IMPRESSION)) {
    if (window.Leya) {
      window.Leya.Events.Prebid.handleImpressionEvent(impression);
    } else {
      utils.logError("Can't log event, Leyajs is not defined");
    }
  }
}

/**
 *
 * @param eventType
 * @param args
 */
function handleOtherEvents(eventType, args) {
  //
}

let leyaAdapter = Object.assign(adapter({analyticsType}), {
  track({eventType, args}) {
    switch (eventType) {
      case AUCTION_INIT:
        handleAuctionInit(args);
        break;
      case BID_REQUESTED:
        handleBidRequested(args);
        break;
      case BID_ADJUSTMENT:
        handleBidAdjustment(args);
        break;
      case BIDDER_DONE:
        handleBidderDone(args);
        break;
      case AUCTION_END:
        handleAuctionEnd(args);
        break;
      case BID_WON:
        handleBidWon(args);
        break;
      case BID_RESPONSE:
        handleBidResponse(args);
        break;
      default:
        handleOtherEvents(eventType, args);
        break;
    }
  }
});

leyaAdapter.originEnableAnalytics = leyaAdapter.enableAnalytics;

leyaAdapter.enableAnalytics = function (config) {
  if (this.initConfig(config)) {
    logInfo('Analytics adapter enabled', initOptions);
    leyaAdapter.originEnableAnalytics(config);
  }
};

leyaAdapter.initConfig = function (config) {
  let isCorrectConfig = true;
  initOptions = {};
  initOptions.options = utils.deepClone(config.options);
  initOptions.adUnits = initOptions.options.adUnits || [];
  initOptions.adUnits = initOptions.adUnits.map(value => value.toLowerCase());

  // version
  let version = initOptions.options.version || $$PREBID_GLOBAL$$.version || 'unknown';

  let tags = ['version', version];
  if (initOptions.options.tags) {
    tags = tags.concat(initOptions.options.tags);
  }

  if (window.Leya) {
    window.Leya.addTags(tags);

    if (initOptions.options.key) {
      window.Leya.setKey(initOptions.options.key);
    }
  } else {
    utils.logError("Can't set tags and key, Leyajs is not defined");
  }

  eventsConfig();

  return isCorrectConfig;
};

leyaAdapter.getOptions = function () {
  return initOptions;
};

function isWantedEvent(type) {
  return !(Number(initOptions.wantedEvents[type] || 0) === 0)
}

function getPrebidAdUnit(adUnitCode) {
  return $$PREBID_GLOBAL$$.adUnits.find(function (prebidAdUnit) {
    return prebidAdUnit.code.toLowerCase() === adUnitCode.toLowerCase();
  });
}

function eventsConfig() {
  initOptions.wantedEvents = {};

  initOptions.wantedEvents[LEYA_EVENTS.AUCTION] = 1;
  initOptions.wantedEvents[LEYA_EVENTS.IMPRESSION] = 1;
  initOptions.wantedEvents[LEYA_EVENTS.BID_AFTER_TIMEOUT] = 1;
}

function logInfo(message, meta) {
  utils.logInfo(buildLogMessage(message), meta);
}

function buildLogMessage(message) {
  return 'Leya Prebid Analytics: ' + message;
}

adapterManager.registerAnalyticsAdapter({
  adapter: leyaAdapter,
  code: 'leya'
});

export default leyaAdapter;
