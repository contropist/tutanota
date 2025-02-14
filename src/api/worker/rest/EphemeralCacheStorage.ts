import {BlobElementEntity, ElementEntity, ListElementEntity, SomeEntity, TypeModel} from "../../common/EntityTypes.js"
import { EntityRestClient, typeRefToPath } from "./EntityRestClient.js"
import { firstBiggerThanSecond, getElementId, getListId } from "../../common/utils/EntityUtils.js"
import { CacheStorage, LastUpdateTime } from "./DefaultEntityRestCache.js"
import { assertNotNull, clone, getFromMap, remove, TypeRef } from "@tutao/tutanota-utils"
import { CustomCacheHandlerMap } from "./CustomCacheHandler.js"
import { resolveTypeReference } from "../../common/EntityFunctions.js"
import { Type as TypeId } from "../../common/EntityConstants.js"
import { ProgrammingError } from "../../common/error/ProgrammingError.js"

/** Cache for a single list. */
type ListCache = {
	/** All entities loaded inside the range. */
	allRange: Id[]
	lowerRangeId: Id
	upperRangeId: Id
	/** All the entities loaded, inside or outside the range (e.g. load for a single entity). */
	elements: Map<Id, ListElementEntity>
}

/** Map from list id to list cache. */
type ListTypeCache = Map<Id, ListCache>

type BlobElementCache = {
	/** All the entities loaded, inside or outside the range (e.g. load for a single entity). */
	elements: Map<Id, BlobElementEntity>
}

/** Map from list id to list cache. */
type BlobElementTypeCache = Map<Id, BlobElementCache>

export interface EphemeralStorageInitArgs {
	userId: Id
}

export class EphemeralCacheStorage implements CacheStorage {
	/** Path to id to entity map. */
	private readonly entities: Map<string, Map<Id, ElementEntity>> = new Map()
	private readonly lists: Map<string, ListTypeCache> = new Map()
	private readonly blobEntities: Map<string, BlobElementTypeCache> = new Map()
	private readonly customCacheHandlerMap: CustomCacheHandlerMap = new CustomCacheHandlerMap()
	private lastUpdateTime: number | null = null
	private userId: Id | null = null
	private lastBatchIdPerGroup = new Map<Id, Id>()

	init({ userId }: EphemeralStorageInitArgs) {
		this.userId = userId
	}

	deinit() {
		this.userId = null
		this.entities.clear()
		this.lists.clear()
		this.blobEntities.clear()
		this.lastUpdateTime = null
		this.lastBatchIdPerGroup.clear()
	}

	/**
	 * Get a given entity from the cache, expects that you have already checked for existence
	 */
	async get<T extends SomeEntity>(typeRef: TypeRef<T>, listId: Id | null, id: Id): Promise<T | null> {
		// We downcast because we can't prove that map has correct entity on the type level
		const path = typeRefToPath(typeRef)
		const typeModel = await resolveTypeReference(typeRef)
		switch (typeModel.type) {
			case TypeId.Element:
				return clone((this.entities.get(path)?.get(id) as T | undefined) ?? null)
			case TypeId.ListElement:
				return clone((this.lists.get(path)?.get(assertNotNull(listId))?.elements.get(id) as T | undefined) ?? null)
			case TypeId.BlobElement:
				return clone((this.blobEntities.get(path)?.get(assertNotNull(listId))?.elements.get(id) as T | undefined) ?? null)
			default:
				throw new ProgrammingError("must be a persistent type")
		}
	}

	async deleteIfExists<T>(typeRef: TypeRef<T>, listId: Id | null, id: Id): Promise<void> {
		const path = typeRefToPath(typeRef)
		let typeModel: TypeModel
		try {
			typeModel = await resolveTypeReference(typeRef)
		} catch (e) {
			// prevent failed lookup for BlobToFileMapping - this catch block can be removed after May 2023
			console.log("couldn't resolve typeRef ", typeRef)
			return
		}
		switch (typeModel.type) {
			case TypeId.Element:
				this.entities.get(path)?.delete(id)
				break
			case TypeId.ListElement:
				const cache = this.lists.get(path)?.get(assertNotNull(listId))
				if (cache != null) {
					cache.elements.delete(id)
					remove(cache.allRange, id)
				}
				break
			case TypeId.BlobElement:
				this.blobEntities.get(path)?.get(assertNotNull(listId))?.elements.delete(id)
				break
			default:
				throw new ProgrammingError("must be a persistent type")
		}
	}

	private addElementEntity<T extends ElementEntity>(typeRef: TypeRef<T>, id: Id, entity: T) {
		getFromMap(this.entities, typeRefToPath(typeRef), () => new Map()).set(id, entity)
	}

	async isElementIdInCacheRange<T extends ListElementEntity>(typeRef: TypeRef<T>, listId: Id, id: Id): Promise<boolean> {
		const cache = this.lists.get(typeRefToPath(typeRef))?.get(listId)
		return cache != null && !firstBiggerThanSecond(id, cache.upperRangeId) && !firstBiggerThanSecond(cache.lowerRangeId, id)
	}

	async put(originalEntity: SomeEntity): Promise<void> {
		const entity = clone(originalEntity)
		const typeRef = entity._type
		const typeModel = await resolveTypeReference(typeRef)
		switch (typeModel.type) {
			case TypeId.Element:
				const elementEntity = entity as ElementEntity
				this.addElementEntity(elementEntity._type, elementEntity._id, elementEntity)
				break
			case TypeId.ListElement:
				const listElementEntity = entity as ListElementEntity
				const listElementTypeRef = typeRef as TypeRef<ListElementEntity>
				await this.putListElement(listElementEntity, listElementTypeRef)
				break
			case TypeId.BlobElement:
				const blobElementEntity = entity as BlobElementEntity
				const blobTypeRef = typeRef as TypeRef<BlobElementEntity>
				await this.putBlobElement(blobElementEntity, blobTypeRef)
				break
			default:
				throw new ProgrammingError("must be a persistent type")
		}
	}

	private async putBlobElement(entity: BlobElementEntity, typeRef: TypeRef<BlobElementEntity>) {
		const listId = getListId(entity)
		const elementId = getElementId(entity)
		const cache = this.blobEntities.get(typeRefToPath(typeRef))?.get(listId)
		if (cache == null) {
			// first element in this list
			const newCache = {
				elements: new Map([[elementId, entity]]),
			}
			getFromMap(this.blobEntities, typeRefToPath(typeRef), () => new Map()).set(listId, newCache)
		} else {
			// if the element already exists in the cache, overwrite it
			cache.elements.set(elementId, entity)
		}
	}

	private async putListElement(entity: ListElementEntity, typeRef: TypeRef<ListElementEntity>) {
		const listId = getListId(entity)
		const elementId = getElementId(entity)
		const cache = this.lists.get(typeRefToPath(typeRef))?.get(listId)
		if (cache == null) {
			// first element in this list
			const newCache = {
				allRange: [elementId],
				lowerRangeId: elementId,
				upperRangeId: elementId,
				elements: new Map([[elementId, entity]]),
			}
			getFromMap(this.lists, typeRefToPath(typeRef), () => new Map()).set(listId, newCache)
		} else {
			// if the element already exists in the cache, overwrite it
			// add new element to existing list if necessary
			cache.elements.set(elementId, entity)
			if (await this.isElementIdInCacheRange(typeRef, listId, elementId)) {
				this.insertIntoRange(cache.allRange, elementId)
			}
		}
	}

	private insertIntoRange(allRange: Array<Id>, elementId: Id) {
		for (let i = 0; i < allRange.length; i++) {
			const rangeElement = allRange[i]
			if (firstBiggerThanSecond(rangeElement, elementId)) {
				allRange.splice(i, 0, elementId)
				return
			}
			if (rangeElement === elementId) {
				return
			}
		}
		allRange.push(elementId)
	}

	async provideFromRange<T extends ListElementEntity>(typeRef: TypeRef<T>, listId: Id, start: Id, count: number, reverse: boolean): Promise<T[]> {
		const listCache = this.lists.get(typeRefToPath(typeRef))?.get(listId)

		if (listCache == null) {
			return []
		}

		let range = listCache.allRange
		let ids: Id[] = []
		if (reverse) {
			let i
			for (i = range.length - 1; i >= 0; i--) {
				if (firstBiggerThanSecond(start, range[i])) {
					break
				}
			}
			if (i >= 0) {
				let startIndex = i + 1 - count
				if (startIndex < 0) {
					// start index may be negative if more elements have been requested than available when getting elements reverse.
					startIndex = 0
				}
				ids = range.slice(startIndex, i + 1)
				ids.reverse()
			} else {
				ids = []
			}
		} else {
			const i = range.findIndex((id) => firstBiggerThanSecond(id, start))
			ids = range.slice(i, i + count)
		}
		let result: T[] = []
		for (let a = 0; a < ids.length; a++) {
			result.push(clone(listCache.elements.get(ids[a]) as T))
		}
		return result
	}

	async getRangeForList<T extends ListElementEntity>(typeRef: TypeRef<T>, listId: Id): Promise<{ lower: Id; upper: Id } | null> {
		const listCache = this.lists.get(typeRefToPath(typeRef))?.get(listId)

		if (listCache == null) {
			return null
		}

		return { lower: listCache.lowerRangeId, upper: listCache.upperRangeId }
	}

	async setUpperRangeForList<T extends ListElementEntity>(typeRef: TypeRef<T>, listId: Id, id: Id): Promise<void> {
		const listCache = this.lists.get(typeRefToPath(typeRef))?.get(listId)
		if (listCache == null) {
			throw new Error("list does not exist")
		}
		listCache.upperRangeId = id
	}

	async setLowerRangeForList<T extends ListElementEntity>(typeRef: TypeRef<T>, listId: Id, id: Id): Promise<void> {
		const listCache = this.lists.get(typeRefToPath(typeRef))?.get(listId)
		if (listCache == null) {
			throw new Error("list does not exist")
		}
		listCache.lowerRangeId = id
	}

	/**
	 * Creates a new list cache if there is none. Resets everything but elements.
	 * @param typeRef
	 * @param listId
	 * @param lower
	 * @param upper
	 */
	async setNewRangeForList<T extends ListElementEntity>(typeRef: TypeRef<T>, listId: Id, lower: Id, upper: Id): Promise<void> {
		const listCache = this.lists.get(typeRefToPath(typeRef))?.get(listId)
		if (listCache == null) {
			getFromMap(this.lists, typeRefToPath(typeRef), () => new Map()).set(listId, {
				allRange: [],
				lowerRangeId: lower,
				upperRangeId: upper,
				elements: new Map(),
			})
		} else {
			listCache.lowerRangeId = lower
			listCache.upperRangeId = upper
			listCache.allRange = []
		}
	}

	async getIdsInRange<T extends ListElementEntity>(typeRef: TypeRef<T>, listId: Id): Promise<Array<Id>> {
		return this.lists.get(typeRefToPath(typeRef))?.get(listId)?.allRange ?? []
	}

	async getLastBatchIdForGroup(groupId: Id): Promise<Id | null> {
		return this.lastBatchIdPerGroup.get(groupId) ?? null
	}

	async putLastBatchIdForGroup(groupId: Id, batchId: Id): Promise<void> {
		this.lastBatchIdPerGroup.set(groupId, batchId)
	}

	purgeStorage(): Promise<void> {
		return Promise.resolve()
	}

	async getLastUpdateTime(): Promise<LastUpdateTime> {
		return this.lastUpdateTime ? { type: "recorded", time: this.lastUpdateTime } : { type: "never" }
	}

	async putLastUpdateTime(value: number): Promise<void> {
		this.lastUpdateTime = value
	}

	async getWholeList<T extends ListElementEntity>(typeRef: TypeRef<T>, listId: Id): Promise<Array<T>> {
		const listCache = this.lists.get(typeRefToPath(typeRef))?.get(listId)

		if (listCache == null) {
			return []
		}

		return listCache.allRange.map((id) => clone(listCache.elements.get(id) as T))
	}

	getCustomCacheHandlerMap(entityRestClient: EntityRestClient): CustomCacheHandlerMap {
		return this.customCacheHandlerMap
	}

	getUserId(): Id {
		return assertNotNull(this.userId, "No user id, not initialized?")
	}

	async deleteAllOwnedBy(owner: Id): Promise<void> {
		for (const typeMap of this.entities.values()) {
			for (const [id, entity] of typeMap.entries()) {
				if (entity._ownerGroup === owner) {
					typeMap.delete(id)
				}
			}
		}
		for (const cacheForType of this.lists.values()) {
			this.deleteAllOwnedByFromCache(cacheForType, owner)
		}
		for (const cacheForType of this.blobEntities.values()) {
			this.deleteAllOwnedByFromCache(cacheForType, owner)
		}
		this.lastBatchIdPerGroup.delete(owner)
	}

	private deleteAllOwnedByFromCache(cacheForType: Map<Id, ListCache | BlobElementCache>, owner: string) {
		// If we find at least one element in the list that is owned by our target owner, we delete the entire list.
		// This is OK in most cases because the vast majority of lists are single owner.
		// For the other cases, we are just clearing the cache a bit sooner than needed.
		const listIdsToDelete: string[] = []
		for (const [listId, listCache] of cacheForType.entries()) {
			for (const [id, element] of listCache.elements.entries()) {
				if (element._ownerGroup === owner) {
					listIdsToDelete.push(listId)
					break
				}
			}
		}
		for (const listId of listIdsToDelete) {
			cacheForType.delete(listId)
		}
	}

	clearExcludedData(): Promise<void> {
		return Promise.resolve()
	}

	/**
	 * We want to lock the access to the "ranges" db when updating / reading the
	 * offline available mail list ranges for each mail list (referenced using the listId)
	 * @param listId the mail list that we want to lock
	 */
	lockRangesDbAccess(listId: string): Promise<void> {
		return Promise.resolve()
	}

	/**
	 * This is the counterpart to the function "lockRangesDbAccess(listId)"
	 * @param listId the mail list that we want to unlock
	 */
	unlockRangesDbAccess(listId: string): Promise<void> {
		return Promise.resolve()
	}
}
