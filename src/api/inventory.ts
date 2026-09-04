import type { SteamDispatch } from '../runtime/dispatch';
import { decodeStruct } from '../runtime/struct';
import { out } from '../runtime/out';
import type { ISteamInventory } from '../generated/interfaces/ISteamInventory';
import type { SteamCallbackMap } from '../generated/callbacks';
import { callbackIdByName } from '../generated/callbacks';
import { layoutOf } from '../generated/structs';
import type {
  SteamInventoryRequestPricesResult_t,
  SteamInventoryStartPurchaseResult_t,
  SteamItemDetails_t,
} from '../generated/structs';
import { k_SteamItemInstanceIDInvalid } from '../generated/consts';
import { ok, must } from './guards';

/**
 * One item stack in the player's inventory, decoded from `SteamItemDetails_t`.
 *
 * @see Inventory.getAll
 */
export interface InventoryItem {
  /** `SteamItemInstanceID_t`, unique per stack. 64-bit, so a `bigint`. */
  itemId: bigint;
  /** `SteamItemDef_t`: which item definition this stack is of. */
  definition: number;
  /** How many of the item this stack holds. */
  quantity: number;
  /** `ESteamItemFlags` bits: 1 no trade, 256 removed, 512 consumed. */
  flags: number;
}

/**
 * One item definition with a price, from `listPrices`.
 *
 * @see Inventory.listPrices
 */
export interface ItemPrice {
  /** `SteamItemDef_t` the price belongs to. */
  definition: number;
  /** Price the user pays right now, in the smallest currency unit (cents). 64-bit, so a `bigint`. */
  currentPrice: bigint;
  /** Price before any discount, in the smallest currency unit (cents). 64-bit, so a `bigint`. */
  basePrice: bigint;
}

/** Reads a NUL-terminated string out of a buffer a flat call wrote into. */
function cstr(buf: Buffer): string {
  const nul = buf.indexOf(0);
  return buf.toString('utf8', 0, nul === -1 ? buf.length : nul);
}

/** Packs `{ definition, quantity }` pairs into the two parallel arrays Steam takes. */
function defArrays(items: { definition: number; quantity: number }[]): { defs: Buffer; quantities: Buffer } {
  const defs = Buffer.alloc(items.length * 4);
  const quantities = Buffer.alloc(items.length * 4);
  items.forEach((item, i) => {
    defs.writeInt32LE(item.definition, i * 4);
    quantities.writeUInt32LE(item.quantity, i * 4);
  });
  return { defs, quantities };
}

/** Packs `{ itemId, quantity }` pairs into the two parallel arrays Steam takes. */
function itemArrays(items: { itemId: bigint; quantity: number }[]): { ids: Buffer; quantities: Buffer } {
  const ids = Buffer.alloc(items.length * 8);
  const quantities = Buffer.alloc(items.length * 4);
  items.forEach((item, i) => {
    ids.writeBigUInt64LE(item.itemId, i * 8);
    quantities.writeUInt32LE(item.quantity, i * 4);
  });
  return { ids, quantities };
}

/**
 * Task level wrapper over ISteamInventory: read and change the player's Steam
 * Inventory Service items without handling result handles yourself.
 *
 * Almost every ISteamInventory call writes a `SteamInventoryResult_t` handle,
 * finishes asynchronously with a `SteamInventoryResultReady_t`, and has to be
 * destroyed afterwards or it leaks. Every method here does that whole cycle:
 * start the call, wait for the result, decode the items, destroy the handle.
 * A non-OK `EResult` becomes a `SteamResultError`.
 *
 * Item definitions are a separate thing from items: they are the catalogue,
 * they arrive with `loadDefinitions`, and they are read synchronously
 * afterwards.
 *
 * Reach it as `steam.items`. Named `items` because the generated
 * ISteamInventory accessor already owns `steam.inventory`.
 *
 * @see Steam.items
 * @see SteamResultError
 */
export class Inventory {
  /**
   * @param inventory - The ISteamInventory interface.
   * @param dispatch - Running pump that resolves the call results.
   * @param subscribe - Callback subscriber, normally `steam.on` bound to the session.
   * @param once - Awaitable callback subscriber, normally `steam.once` bound to the session.
   */
  constructor(
    private readonly inventory: ISteamInventory,
    private readonly dispatch: SteamDispatch,
    private readonly subscribe: <K extends keyof SteamCallbackMap & string>(
      name: K,
      listener: (data: SteamCallbackMap[K]) => void,
    ) => () => void,
    private readonly once: <K extends keyof SteamCallbackMap & string>(
      name: K,
      match?: (data: SteamCallbackMap[K]) => boolean,
    ) => Promise<SteamCallbackMap[K]>,
  ) {}

  /**
   * Reads every item the player owns for this app.
   *
   * Steam also fires this result on its own whenever the inventory changes;
   * `onChange` is the way to hear about that.
   *
   * @returns One entry per item stack. Empty for a player who owns nothing.
   * @throws Error if Steam refused to start the call, which usually means the app has no Inventory Service.
   * @throws SteamResultError if the call completed with a non-OK `EResult`.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * for (const item of await steam.items.getAll()) console.log(item.definition, item.quantity);
   * steam.close();
   * ```
   * @see getByIds
   * @see onChange
   */
  getAll(): Promise<InventoryItem[]> {
    return this.collect('GetAllItems', (handle) => this.inventory.GetAllItems(handle));
  }

  /**
   * Reads the named item stacks only.
   *
   * Cheaper than `getAll` when you already know which stacks you care about,
   * for example the ones a previous call returned.
   *
   * @param itemIds - Item instance ids to read. 64-bit, so `bigint`s.
   * @returns The stacks Steam found. Ids the player does not own are left out.
   * @throws Error if Steam refused to start the call.
   * @throws SteamResultError if the call completed with a non-OK `EResult`.
   * @see getAll
   */
  getByIds(itemIds: bigint[]): Promise<InventoryItem[]> {
    if (itemIds.length === 0) return Promise.resolve([]);
    const ids = Buffer.alloc(itemIds.length * 8);
    itemIds.forEach((id, i) => ids.writeBigUInt64LE(id, i * 8));
    return this.collect('GetItemsByID', (handle) => this.inventory.GetItemsByID(handle, ids, itemIds.length));
  }

  /**
   * Downloads the item definition catalogue and resolves once Steam has it.
   *
   * Call this once at startup. `listDefinitions`, `definitionProperty`, and
   * `definitionProperties` all read the cache this fills, and return nothing
   * before it is filled.
   *
   * @throws Error if Steam refused the request, for example while the client is offline.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * await steam.items.loadDefinitions();
   * console.log(steam.items.listDefinitions());
   * steam.close();
   * ```
   * @see listDefinitions
   */
  async loadDefinitions(): Promise<void> {
    must('LoadItemDefinitions', this.inventory.LoadItemDefinitions());
    await this.once('SteamInventoryDefinitionUpdate_t');
  }

  /**
   * Lists the item definition ids in the loaded catalogue.
   *
   * @returns The definition ids, or an empty array while the catalogue is not loaded.
   * @see loadDefinitions
   */
  listDefinitions(): number[] {
    const count = out.uint32();
    if (!this.inventory.GetItemDefinitionIDs(null, count.buffer)) return [];
    if (count.value === 0) return [];
    const buffer = Buffer.alloc(count.value * 4);
    if (!this.inventory.GetItemDefinitionIDs(buffer, count.buffer)) return [];
    const ids: number[] = [];
    for (let i = 0; i < count.value; i++) ids.push(buffer.readInt32LE(i * 4));
    return ids;
  }

  /**
   * Reads one property of one item definition.
   *
   * Every property is a string, whatever its type on the partner site: a
   * boolean comes back as `"true"`, a number as its digits. Pass an empty
   * `name` to get the comma-separated list of property names this definition
   * has, which is what `definitionProperties` does.
   *
   * @param definition - `SteamItemDef_t` to read.
   * @param name - Property name, for example `name` or `icon_url`. Empty for the key list.
   * @returns The value, or null if the definition or the property does not exist.
   * @see definitionProperties
   */
  definitionProperty(definition: number, name: string): string | null {
    // Valve documents a NULL name as "give me the key list"; koffi passes the
    // null through for a 'str' argument unchanged.
    const key = name === '' ? (null as unknown as string) : name;
    const size = out.uint32();
    if (!this.inventory.GetItemDefinitionProperty(definition, key, null, size.buffer)) return null;
    if (size.value === 0) return '';
    const buffer = Buffer.alloc(size.value);
    if (!this.inventory.GetItemDefinitionProperty(definition, key, buffer, size.buffer)) return null;
    return cstr(buffer);
  }

  /**
   * Reads every property of one item definition.
   *
   * One flat call for the key list, then one per key.
   *
   * @param definition - `SteamItemDef_t` to read.
   * @returns Property name to value. Empty if the definition does not exist or the catalogue is not loaded.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * await steam.items.loadDefinitions();
   * console.log(steam.items.definitionProperties(100).name);
   * steam.close();
   * ```
   * @see definitionProperty
   */
  definitionProperties(definition: number): Record<string, string> {
    // A prototype-free object, so a property named __proto__ or constructor
    // stays a normal entry instead of touching the prototype chain.
    const properties: Record<string, string> = Object.create(null);
    const keys = this.definitionProperty(definition, '');
    if (!keys) return properties;
    for (const key of keys.split(',')) {
      if (key === '') continue;
      const value = this.definitionProperty(definition, key);
      if (value !== null) properties[key] = value;
    }
    return properties;
  }

  /**
   * Consumes some of one item stack, permanently.
   *
   * This is the "use the potion" call. Steam removes the quantity from the
   * stack and cannot put it back.
   *
   * @param itemId - Stack to consume from. 64-bit, so a `bigint`.
   * @param quantity - How many to consume.
   * @defaultValue 1
   * @returns The stack as it stands after the consume, which is empty once the last one is gone.
   * @throws Error if Steam refused to start the call.
   * @throws SteamResultError if Steam refused the consume, for example with `k_EResultInvalidParam` for a stack the player does not own.
   * @see exchange
   */
  consume(itemId: bigint, quantity = 1): Promise<InventoryItem[]> {
    return this.collect('ConsumeItem', (handle) => this.inventory.ConsumeItem(handle, itemId, quantity));
  }

  /**
   * Crafts items out of other items in one step.
   *
   * Steam checks the exchange against the recipes configured on the partner
   * site and refuses anything that is not one of them, so this cannot mint
   * items on its own.
   *
   * @param generate - Item definitions to create, with quantities. Usually one entry.
   * @param destroy - Item stacks to consume for it, with quantities.
   * @returns The generated items.
   * @throws Error if Steam refused to start the call.
   * @throws SteamResultError if Steam refused the exchange, for example when no recipe matches.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const made = await steam.items.exchange([{ definition: 110, quantity: 1 }], [{ itemId: 3001n, quantity: 3 }]);
   * steam.close();
   * ```
   * @see consume
   */
  exchange(
    generate: { definition: number; quantity: number }[],
    destroy: { itemId: bigint; quantity: number }[],
  ): Promise<InventoryItem[]> {
    const g = defArrays(generate);
    const d = itemArrays(destroy);
    return this.collect('ExchangeItems', (handle) =>
      this.inventory.ExchangeItems(
        handle,
        g.defs,
        g.quantities,
        generate.length,
        d.ids,
        d.quantities,
        destroy.length,
      ),
    );
  }

  /**
   * Moves quantity between two stacks, or splits a stack into a new one.
   *
   * With no destination the quantity moves into a brand new stack, which is
   * how you split. With a destination the two stacks merge, which only works
   * if both are of the same item definition.
   *
   * @param sourceItemId - Stack to take from. 64-bit, so a `bigint`.
   * @param quantity - How many to move.
   * @param destinationItemId - Stack to move into. 64-bit, so a `bigint`.
   * @defaultValue `k_SteamItemInstanceIDInvalid`, which creates a new stack
   * @returns The stacks Steam changed.
   * @throws Error if Steam refused to start the call.
   * @throws SteamResultError if Steam refused the transfer.
   */
  transfer(
    sourceItemId: bigint,
    quantity: number,
    destinationItemId: bigint = k_SteamItemInstanceIDInvalid,
  ): Promise<InventoryItem[]> {
    return this.collect('TransferItemQuantity', (handle) =>
      this.inventory.TransferItemQuantity(handle, sourceItemId, quantity, destinationItemId),
    );
  }

  /**
   * Creates items out of nothing, for testing.
   *
   * Steam only allows this for accounts marked as developers of the app, so it
   * fails in a shipped build. Use it to seed a test inventory.
   *
   * @param items - Item definitions to create, with quantities.
   * @returns The created items.
   * @throws Error if Steam refused to start the call.
   * @throws SteamResultError if Steam refused the call, for example with `k_EResultAccessDenied` on a non-developer account.
   * @see exchange
   */
  generate(items: { definition: number; quantity: number }[]): Promise<InventoryItem[]> {
    const { defs, quantities } = defArrays(items);
    return this.collect('GenerateItems', (handle) =>
      this.inventory.GenerateItems(handle, defs, quantities, items.length),
    );
  }

  /**
   * Grants every promo item this player is eligible for.
   *
   * Eligibility comes from the promo rules on the partner site, for example
   * owning another app. Granting an item the player already has is a no-op, so
   * calling this at startup is safe.
   *
   * @returns The items Steam granted. Empty when there was nothing to grant.
   * @throws Error if Steam refused to start the call.
   * @throws SteamResultError if the call completed with a non-OK `EResult`.
   * @see addPromoItems
   */
  grantPromoItems(): Promise<InventoryItem[]> {
    return this.collect('GrantPromoItems', (handle) => this.inventory.GrantPromoItems(handle));
  }

  /**
   * Grants the named promo items, if the player is eligible for them.
   *
   * The narrow form of `grantPromoItems`, for when you only want to hand out
   * one promotion instead of every outstanding one.
   *
   * @param definitions - `SteamItemDef_t` ids to grant.
   * @returns The items Steam granted. Empty when the player was eligible for none of them.
   * @throws Error if Steam refused to start the call.
   * @throws SteamResultError if the call completed with a non-OK `EResult`.
   * @see grantPromoItems
   */
  addPromoItems(definitions: number[]): Promise<InventoryItem[]> {
    const defs = Buffer.alloc(definitions.length * 4);
    definitions.forEach((def, i) => defs.writeInt32LE(def, i * 4));
    return this.collect('AddPromoItems', (handle) =>
      this.inventory.AddPromoItems(handle, defs, definitions.length),
    );
  }

  /**
   * Asks Steam whether a timed drop is due, and takes it if it is.
   *
   * Steam decides, using the drop rules on the partner site. Most calls come
   * back with no items, which is not an error. Do not poll this: call it at a
   * natural moment such as the end of a match.
   *
   * @param dropListDefinition - `SteamItemDef_t` of the drop list to roll against.
   * @returns The dropped items, usually empty.
   * @throws Error if Steam refused to start the call.
   * @throws SteamResultError if the call completed with a non-OK `EResult`.
   * @see sendDropHeartbeat
   */
  triggerDrop(dropListDefinition: number): Promise<InventoryItem[]> {
    return this.collect('TriggerItemDrop', (handle) =>
      this.inventory.TriggerItemDrop(handle, dropListDefinition),
    );
  }

  /**
   * Tells Steam the player is still playing, for playtime-based drops.
   *
   * Send it about once a minute while the game is running. Steam gives no
   * result, so it cannot fail from here.
   *
   * @see triggerDrop
   */
  sendDropHeartbeat(): void {
    this.inventory.SendItemDropHeartbeat();
  }

  /**
   * Downloads the current prices and resolves with the user's currency.
   *
   * `listPrices` and `price` read the cache this fills, so call this first.
   * Prices only exist for item definitions that are for sale in the in-game
   * store.
   *
   * @returns The three-letter currency code the prices are in, for example `EUR`.
   * @throws SteamResultError if Steam refused the request, for example with `k_EResultInvalidState` for an app with no store.
   * @throws SteamApiCallError if the call could not be completed.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const currency = await steam.items.requestPrices();
   * for (const p of steam.items.listPrices()) console.log(p.definition, p.currentPrice, currency);
   * steam.close();
   * ```
   * @see listPrices
   */
  async requestPrices(): Promise<string> {
    const call = this.inventory.RequestPrices();
    const r = await this.dispatch.callResultStruct<SteamInventoryRequestPricesResult_t>(
      call,
      layoutOf('SteamInventoryRequestPricesResult_t'),
      callbackIdByName.SteamInventoryRequestPricesResult_t,
    );
    ok('RequestPrices', r.m_result);
    return r.m_rgchCurrency;
  }

  /**
   * Lists every item definition that has a price.
   *
   * Prices are in the smallest unit of the currency `requestPrices` returned,
   * so 199 means 1.99 in a currency with cents.
   *
   * @returns One entry per priced definition, or an empty array before `requestPrices` resolved.
   * @see requestPrices
   */
  listPrices(): ItemPrice[] {
    const count = this.inventory.GetNumItemsWithPrices();
    if (count === 0) return [];
    const defs = Buffer.alloc(count * 4);
    const current = Buffer.alloc(count * 8);
    const base = Buffer.alloc(count * 8);
    if (!this.inventory.GetItemsWithPrices(defs, current, base, count)) return [];
    const prices: ItemPrice[] = [];
    for (let i = 0; i < count; i++) {
      prices.push({
        definition: defs.readInt32LE(i * 4),
        currentPrice: current.readBigUInt64LE(i * 8),
        basePrice: base.readBigUInt64LE(i * 8),
      });
    }
    return prices;
  }

  /**
   * Reads the price of one item definition.
   *
   * @param definition - `SteamItemDef_t` to read.
   * @returns The two prices, in the smallest currency unit, or null if the definition is not for sale.
   * @see requestPrices
   */
  price(definition: number): { currentPrice: bigint; basePrice: bigint } | null {
    const current = out.uint64();
    const base = out.uint64();
    if (!this.inventory.GetItemPrice(definition, current.buffer, base.buffer)) return null;
    return { currentPrice: current.value, basePrice: base.value };
  }

  /**
   * Starts a purchase and resolves once Steam accepted the order.
   *
   * Steam shows the checkout in the overlay, so the overlay has to be enabled.
   * The promise resolving means the order exists, not that the player paid:
   * the items appear later, which `onChange` hears about.
   *
   * @param items - Item definitions to buy, with quantities.
   * @returns The order id and the transaction id. Both 64-bit, so `bigint`s.
   * @throws SteamResultError if Steam refused the purchase, for example with `k_EResultInvalidParam` for a definition that is not for sale.
   * @throws SteamApiCallError if the call could not be completed.
   * @see requestPrices
   * @see onChange
   */
  async startPurchase(items: { definition: number; quantity: number }[]): Promise<{ orderId: bigint; transactionId: bigint }> {
    const { defs, quantities } = defArrays(items);
    const call = this.inventory.StartPurchase(defs, quantities, items.length);
    const r = await this.dispatch.callResultStruct<SteamInventoryStartPurchaseResult_t>(
      call,
      layoutOf('SteamInventoryStartPurchaseResult_t'),
      callbackIdByName.SteamInventoryStartPurchaseResult_t,
    );
    ok('StartPurchase', r.m_result);
    return { orderId: r.m_ulOrderID, transactionId: r.m_ulTransID };
  }

  /**
   * Subscribes to Steam's own "the inventory changed" callback.
   *
   * Steam sends `SteamInventoryFullUpdate_t` whenever the inventory changed
   * outside this process, for example after a purchase, a trade, or a market
   * sale. The listener gets the full item list, already decoded, and the
   * result handle is destroyed afterwards.
   *
   * @param listener - Runs on every full update, with every item the player owns.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const off = steam.items.onChange((items) => console.log(`${items.length} stacks`));
   * // later: off();
   * ```
   * @see getAll
   */
  onChange(listener: (items: InventoryItem[]) => void): () => void {
    return this.subscribe('SteamInventoryFullUpdate_t', (e) => {
      try {
        listener(this.readItems(e.m_handle));
      } finally {
        this.inventory.DestroyResult(e.m_handle);
      }
    });
  }

  /**
   * Runs one result-handle call end to end.
   *
   * Starts the flat call, waits for the matching `SteamInventoryResultReady_t`,
   * decodes the items, and destroys the handle in a `finally` so a failed call
   * leaks nothing. The wait is registered before anything is awaited, so a
   * result that arrives on the very next pump tick is not missed.
   *
   * @param operation - Flat method name, for the error messages.
   * @param start - Runs the flat call with the `SteamInventoryResult_t` out buffer.
   * @returns The items the result carried.
   * @throws Error if `start` returned false.
   * @throws SteamResultError if the result completed with a non-OK `EResult`.
   */
  private async collect(operation: string, start: (handle: Buffer) => boolean): Promise<InventoryItem[]> {
    const result = out.int32();
    must(operation, start(result.buffer));
    const handle = result.value;
    const ready = this.once('SteamInventoryResultReady_t', (e) => e.m_handle === handle);
    try {
      ok(operation, (await ready).m_result);
      return this.readItems(handle);
    } finally {
      this.inventory.DestroyResult(handle);
    }
  }

  /**
   * Decodes the items of a finished result handle.
   *
   * Two calls, as the flat API wants: a null array to learn the count, then a
   * buffer of exactly that many 16-byte rows.
   *
   * @param handle - A `SteamInventoryResult_t` that is ready.
   * @returns One entry per item stack.
   * @throws Error if `GetResultItems` returned false, which means the handle is invalid.
   */
  private readItems(handle: number): InventoryItem[] {
    const count = out.uint32();
    must('GetResultItems', this.inventory.GetResultItems(handle, null, count.buffer));
    if (count.value === 0) return [];
    const layout = layoutOf('SteamItemDetails_t');
    const buffer = Buffer.alloc(count.value * layout.size);
    must('GetResultItems', this.inventory.GetResultItems(handle, buffer, count.buffer));
    const items: InventoryItem[] = [];
    for (let i = 0; i < count.value; i++) {
      const d = decodeStruct<SteamItemDetails_t>(buffer.subarray(i * layout.size, (i + 1) * layout.size), layout);
      items.push({
        itemId: d.m_itemId,
        definition: d.m_iDefinition,
        quantity: d.m_unQuantity,
        flags: d.m_unFlags,
      });
    }
    return items;
  }
}
