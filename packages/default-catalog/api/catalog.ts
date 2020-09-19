import jwt from 'jwt-simple';
import request from 'request';
import ProcessorFactory from '../processor/factory';
import { adjustBackendProxyUrl } from '@storefront-api/lib/elastic'
import cache from '@storefront-api/lib/cache-instance'
import { sha3_224 } from 'js-sha3'
import Logger from '@storefront-api/lib/logger'
import bodybuilder from 'bodybuilder'
import { elasticsearch, SearchQuery } from 'storefront-query-builder'
import AttributeService from './attribute/service'
import loadCustomFilters from '../helper/loadCustomFilters'
import { apiError } from '@storefront-api/lib/util'

function _cacheStorageHandler (config, result, hash, tags) {
  if (config.server.useOutputCache && cache) {
    cache.set(
      'api:' + hash,
      result,
      tags
    ).catch((err) => {
      Logger.error(err)
    })
  }
}

function _outputFormatter (responseBody, format = 'standard') {
  if (format === 'compact') { // simple formatter
    delete responseBody.took
    delete responseBody.timed_out
    delete responseBody._shards
    if (responseBody.hits) {
      delete responseBody.hits.max_score
      responseBody.total = responseBody.hits.total
      responseBody.hits = responseBody.hits.hits.map(hit => {
        return Object.assign(hit._source, { _score: hit._score })
      })
    }
  }
  return responseBody
}

export default ({config, db}) => async function (req, res, body) {
  let groupId = null

  // Request method handling: exit if not GET or POST
  // Other metods - like PUT, DELETE etc. should be available only for authorized users or not available at all)
  if (!(req.method === 'GET' || req.method === 'POST' || req.method === 'OPTIONS')) {
    throw new Error('ERROR: ' + req.method + ' request method is not supported.')
  }

  let requestBody: Record<string, any> = req.body as Record<string, any>
  let responseFormat = 'standard'
  if (req.method === 'GET') {
    if (req.query.request) { // this is in fact optional
      requestBody = JSON.parse(decodeURIComponent(req.query.request))
    }
  }

  if (req.query.request_format === 'search-query') { // search query and not Elastic DSL - we need to translate it
    const customFilters = await loadCustomFilters(config)
    requestBody = await elasticsearch.buildQueryBodyFromSearchQuery({ config, queryChain: bodybuilder(), searchQuery: new SearchQuery(requestBody), customFilters })
  }
  if (req.query.response_format) responseFormat = req.query.response_format

  const urlSegments = req.url.split('/');

  let indexName = ''
  let entityType = ''
  if (urlSegments.length < 2) { throw new Error('No index name given in the URL. Please do use following URL format: /api/catalog/<index_name>/<entity_type>_search') } else {
    indexName = urlSegments[1];

    if (urlSegments.length > 2) { entityType = urlSegments[2] }

    if (config.elasticsearch.indices.indexOf(indexName) < 0) {
      throw new Error('Invalid / inaccessible index name given in the URL. Please do use following URL format: /api/catalog/<index_name>/_search')
    }

    if (urlSegments[urlSegments.length - 1].indexOf('_search') !== 0) {
      throw new Error('Please do use following URL format: /api/catalog/<index_name>/_search')
    }
  }

  // pass the request to elasticsearch
  const elasticBackendUrl = adjustBackendProxyUrl(req, indexName, entityType, config)
  const userToken = requestBody.groupToken

  // Decode token and get group id
  if (userToken && userToken.length > 10) {
    const decodeToken = jwt.decode(userToken, config.authHashSecret ? config.authHashSecret : config.objHashSecret)
    groupId = decodeToken.group_id || groupId
  } else if (requestBody.groupId) {
    groupId = requestBody.groupId || groupId
  }

  delete requestBody.groupToken
  delete requestBody.groupId

  let auth = null;

  // Only pass auth if configured
  if (config.elasticsearch.user || config.elasticsearch.password) {
    auth = {
      user: config.elasticsearch.user,
      pass: config.elasticsearch.password
    };
  }
  const s = Date.now()
  const reqHash = sha3_224(`${JSON.stringify(requestBody)}${req.url}`)
  const dynamicRequestHandler = () => {
    request({ // do the elasticsearch request
      uri: elasticBackendUrl,
      method: req.method,
      body: requestBody,
      json: true,
      auth: auth
    }, async (_err, _res, _resBody) => { // TODO: add caching layer to speed up SSR? How to invalidate products (checksum on the response BEFORE processing it)
      if (_err || _resBody.error) {
        apiError(res, _err || _resBody.error);
        return
      }
      try {
        if (_resBody && _resBody.hits && _resBody.hits.hits) { // we're signing up all objects returned to the client to be able to validate them when (for example order)
          const factory = new ProcessorFactory(config)
          const tagsArray = []
          if (config.server.useOutputCache && cache) {
            const tagPrefix = entityType[0].toUpperCase() // first letter of entity name: P, T, A ...
            tagsArray.push(entityType)
            _resBody.hits.hits.map(item => {
              if (item._source.id) { // has common identifier
                tagsArray.push(`${tagPrefix}${item._source.id}`)
              }
            })
            const cacheTags = tagsArray.join(' ')
            res.setHeader('X-VS-Cache-Tags', cacheTags)
          }

          let resultProcessor = factory.getAdapter(entityType, indexName, req, res)

          if (!resultProcessor) { resultProcessor = factory.getAdapter('default', indexName, req, res) } // get the default processor

          const productGroupId = entityType === 'product' ? groupId : undefined
          const result = await resultProcessor.process(_resBody.hits.hits, productGroupId)
          _resBody.hits.hits = result
          _resBody = _outputFormatter(_resBody, responseFormat)
          if (entityType === 'product' && _resBody.aggregations && config.entities.attribute.loadByAttributeMetadata) {
            const attributeListParam = AttributeService.transformAggsToAttributeListParam(_resBody.aggregations)
            // find attribute list
            const attributeList = await AttributeService.list(attributeListParam, config, indexName)
            _resBody.attribute_metadata = attributeList.map(AttributeService.transformToMetadata)
          }
          _cacheStorageHandler(config, _resBody, reqHash, tagsArray)
          res.json(_resBody);
        } else { // no cache storage if no results from Elastic
          res.json(_resBody);
        }
      } catch (err) {
        apiError(res, err);
      }
    });
  }

  if (config.server.useOutputCache && cache) {
    cache.get(
      'api:' + reqHash
    ).then(output => {
      if (output !== null) {
        res.setHeader('X-VS-Cache', 'Hit')
        res.json(output)
        Logger.info(`cache hit [${req.url}], cached request: ${Date.now() - s}ms`)
      } else {
        res.setHeader('X-VS-Cache', 'Miss')
        Logger.info(`cache miss [${req.url}], request: ${Date.now() - s}ms`)
        dynamicRequestHandler()
      }
    }).catch(err => Logger.error(err))
  } else {
    dynamicRequestHandler()
  }
}
