var boom = require('boom')
var braveHapi = require('../brave-hapi')
var Joi = require('joi')
var underscore = require('underscore')

var v0 = {}

/*
   GET  /replacement?braveUserId={userId}
 */

v0.get =
{ handler: function (runtime) {
  return async function (request, reply) {
    var ad, count, image, url
    var debug = braveHapi.debug(module, request)
    var height = request.query.height
    var userId = request.query.braveUserId
    var width = request.query.width
    var users = runtime.db.get('users')

    count = await users.update({ userId: userId }, { $inc: { statAdReplaceCount: 1 } }, { upsert: true })
    if (typeof count === 'object') { count = count.nMatched }
    if (count === 0) { return reply(boom.notFound('user entry does not exist', { braveUserId: userId })) }

    // retrieve an ad for an intent and size
    ad = runtime.sonobi.adUnitForIntent(request.query, width, height)

    // TODO - refill the in memory caches
    // Warning - this is a fire and forget call - we are NOT
    // waiting for the results.
    runtime.sonobi.prefill()

    // What to do if there are no valid ads? server a placeholder?
    image = '<img src="https://placeimg.com/' + width + '/' + height + '"/>'

    // TODO - ensure ad.lp and ad.url are safe
    if (ad !== null) {
      image = '<a href="' + ad.lp + '" target="_blank"><img src="' + ad.url + '"/></a>'
    } else {
      debug('default ad returned')
    }

    url = 'data:text/html,<html><body style="width: ' + width +
          'px; height: ' + height +
          'px; padding: 0; margin: 0;">' +
          image +
          '<div style="background-color:blue; color: white; font-weight: bold; position: absolute; top: 0;">Use Brave</div></body></html>'

    debug('serving ad for query ', request.query, ' with url: ', url)
    reply.redirect(url)
  }
},

validate:
  { query:
    { braveUserId: Joi.string().guid().required(),
      intentHost: Joi.string().hostname().required(),
      tagName: Joi.string().required(),
      width: Joi.number().positive().required(),
      height: Joi.number().positive().required()
    }
  }
}

var v1 = {}

/*
   GET  /v1/users/{userId}/replacement?...
 */

v1.get =
{ handler: function (runtime) {
  return async function (request, reply) {
    var ad, count, href, img, result, url
    var debug = braveHapi.debug(module, request)
    var host = request.headers.host
    var protocol = request.url.protocol || 'http'
    var sessionId = request.query.sessionId
    var height = request.query.height
    var width = request.query.width
    var userId = request.params.userId
    var adUnits = runtime.db.get('ad_units')
    var sessions = runtime.db.get('sessions')
    var users = runtime.db.get('users')

    count = await users.update({ userId: userId }, { $inc: { statAdReplaceCount: 1 } }, { upsert: false })
    if (typeof count === 'object') { count = count.nMatched }
    if (count === 0) { return reply(boom.notFound('user entry does not exist', { braveUserId: userId })) }

    ad = runtime.sonobi.adUnitForIntent(request.query, width, height)

    if (ad) {
      href = ad.lp
      img = '<img src="' + ad.url + '" />'
    } else {
      href = 'https://brave.com/'
      img = '<img src="https://placeimg.com/' + width + '/' + height + '/any" />'
    }

    result = await adUnits.insert(underscore.extend(request.query, { href: href, img: img }
                                 , underscore.omit(ad || {}, 'lp', 'url')))

    url = 'data:text/html,<html><body style="width: ' + width +
          'px; height: ' + height +
          'px; padding: 0; margin: 0;">' +
          '<a href="' + protocol + '://' + host + '/v1/ad-clicks/' + result['_' + 'id'] + '" target="_blank">' + img + '</a>' +
          '<div style="background-color:blue; color: white; font-weight: bold; position: absolute; top: 0;">Use Brave</div></body></html>'

    // NB: X-Brave: header is just for debugging
    reply.redirect(url).header('x-brave', protocol + '://' + host + '/v1/ad-clicks/' + result['_' + 'id'])

    try { runtime.sonobi.prefill() } catch (ex) { debug('prefill failed', ex) }

    try {
      await sessions.update({ sessionId: sessionId, userId: userId },
                            { $currentDate: { timestamp: { $type: 'timestamp' } },
                              $set: { activity: 'ad' },
                              $inc: { statAdReplaceCount: 1 }
                             },
                           { upsert: true })
    } catch (ex) {
      debug('update failed', ex)
    }
  }
},

validate:
  { query:
    { sessionId: Joi.string().guid().required(),
      tagName: Joi.string().required(),
      width: Joi.number().positive().required(),
      height: Joi.number().positive().required()
    },
    params:
    { userId: Joi.string().guid().required() }
  }
}

/*
   GET  /v1/ad-clicks/{adUnitId}
 */

v1.getClicks =
{ handler: function (runtime) {
  return async function (request, reply) {
    var result
    var debug = braveHapi.debug(module, request)
    var adUnitId = request.params.adUnitId
    var adUnits = runtime.db.get('ad_units')

    result = await adUnits.findOne({ _id: adUnitId })
    if (!result) { return reply(boom.notFound('', { adUnitId: adUnitId })) }

    reply.redirect(result.href)

    try {
      await adUnits.update({ _id: adUnitId }
                           , { $currentDate: { timestamp: { $type: 'timestamp' } } }
                           , { upsert: true })
    } catch (ex) {
      debug('update failed', ex)
    }
  }
},

validate:
  { params:
    { adUnitId: Joi.string().hex().required() }
  }
}

module.exports.routes =
[
  // Remove /ad once clients have moved onto /replacement or /v1/
  braveHapi.routes.async().path('/ad').config(v0.get),
  braveHapi.routes.async().path('/replacement').config(v0.get),
  braveHapi.routes.async().path('/v1/users/{userId}/replacement').config(v1.get),
  braveHapi.routes.async().path('/v1/ad-clicks/{adUnitId}').config(v1.getClicks)
]

module.exports.initialize = async function (debug, runtime) {
  runtime.db.checkIndices(debug,
  [ { category: runtime.db.get('ad_units'),
      name: 'ad_units',
      property: 'adUnitId',
      empty: { sessionId: '' },
      others: [ { sessionId: 1 } ]
    }
  ])
}