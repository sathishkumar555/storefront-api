import AbstractTaxProxy from '@storefront-api/platform-abstract/tax'
import { calculateProductTax, checkIfTaxWithUserGroupIsActive, getUserGroupIdToUse } from '@storefront-api/lib/taxcalc'
import TierHelper from '@storefront-api/lib/helpers/priceTiers'
import bodybuilder from 'bodybuilder'
import es from '@storefront-api/lib/elastic'

class TaxProxy extends AbstractTaxProxy {
  private readonly _deprecatedPriceFieldsSupport: any
  private readonly _taxCountry: any
  private readonly _taxRegion: any
  private _taxClasses: any

  public constructor (config, entityType, indexName, taxCountry, taxRegion = '', sourcePriceInclTax = null, finalPriceInclTax = null) {
    super(config)
    this._entityType = entityType
    this._indexName = indexName
    this._sourcePriceInclTax = sourcePriceInclTax
    this._finalPriceInclTax = finalPriceInclTax
    this._userGroupId = this._config.get('tax.userGroupId')
    this._storeConfigTax = this._config.get('tax')
    const storeViews = this._config.get<Record<string, any>>('storeViews')
    if (storeViews && storeViews.multistore) {
      for (let storeCode in storeViews) {
        const store = storeViews[storeCode]

        if (typeof store === 'object') {
          if (store.elasticsearch && store.elasticsearch.index) { // workaround to map stores
            if (store.elasticsearch.index === indexName) {
              taxRegion = store.tax.defaultRegion
              taxCountry = store.tax.defaultCountry
              sourcePriceInclTax = store.tax.sourcePriceIncludesTax || null
              finalPriceInclTax = store.tax.finalPriceIncludesTax || null
              this._storeConfigTax = store.tax
              break;
            }
          }
        }
      }
    } else {
      if (!taxRegion) {
        taxRegion = this._config.get('tax.defaultRegion')
      }
      if (!taxCountry) {
        taxCountry = this._config.get('tax.defaultCountry')
      }
    }
    if (sourcePriceInclTax === null) {
      sourcePriceInclTax = this._config.get('tax.sourcePriceIncludesTax')
    }
    if (finalPriceInclTax === null) {
      finalPriceInclTax = this._config.get('tax.finalPriceIncludesTax')
    }
    this._deprecatedPriceFieldsSupport = this._config.get('tax.deprecatedPriceFieldsSupport')
    this._taxCountry = taxCountry
    this._taxRegion = taxRegion
    this._sourcePriceInclTax = sourcePriceInclTax
    this._finalPriceInclTax = finalPriceInclTax
    this.taxFor = this.taxFor.bind(this)
  }

  public taxFor (product: any, groupId: any): Promise<any>|any {
    return calculateProductTax({
      product,
      taxClasses: this._taxClasses,
      taxCountry: this._taxCountry,
      taxRegion: this._taxRegion,
      sourcePriceInclTax: this._sourcePriceInclTax,
      deprecatedPriceFieldsSupport: this._deprecatedPriceFieldsSupport,
      finalPriceInclTax: this._finalPriceInclTax,
      userGroupId: groupId,
      isTaxWithUserGroupIsActive: checkIfTaxWithUserGroupIsActive(this._storeConfigTax) && typeof groupId === 'number'
    })
  }

  public applyTierPrices (productList, groupId) {
    if (this._config.get('usePriceTiers')) {
      for (let item of productList) {
        TierHelper(item._source, groupId)
      }
    }
  }

  public process (productList, groupId = null) {
    const inst = this
    return new Promise((resolve, reject) => {
      inst.applyTierPrices(productList, groupId)

      if (this._config.get('tax.calculateServerSide')) {
        const client = es.getClient(this._config)
        const esQuery = es.adjustQuery({
          index: this._indexName,
          body: bodybuilder()
        }, 'taxrule', this._config)

        client.search(esQuery).then((result) => { // we're always trying to populate cache - when online
          inst._taxClasses = es.getHits(result).map(el => { return el._source })
          for (let item of productList) {
            const isActive = checkIfTaxWithUserGroupIsActive(inst._storeConfigTax)
            if (isActive) {
              groupId = getUserGroupIdToUse(inst._userGroupId, inst._storeConfigTax)
            } else {
              groupId = null
            }

            inst.taxFor(item._source, groupId)
          }

          resolve(productList)
        }).catch(err => {
          reject(err)
        })
      } else {
        resolve(productList)
      }
    })
  }
}

export default TaxProxy
