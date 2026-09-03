import type { ISteamInput } from '../generated/interfaces/ISteamInput';
import type { SteamCallbackMap } from '../generated/callbacks';
import type { InputMotionData_t, SteamInputConfigurationLoaded_t } from '../generated/structs';
import { ESteamInputGlyphSize } from '../generated/enums';

/** Steam never reports more than this many controllers. `STEAM_INPUT_MAX_COUNT` in the SDK. */
const MAX_CONTROLLERS = 16;
/** One `InputHandle_t` is a 64-bit value, so eight bytes per slot in the out buffer. */
const HANDLE_BYTES = 8;

/**
 * The state of one digital (on or off) action.
 *
 * @see Controllers.digital
 */
export interface DigitalAction {
  /** True while the action is pressed. */
  state: boolean;
  /** True while the action is bound in the active action set. A false here makes `state` meaningless. */
  active: boolean;
}

/**
 * The state of one analog (stick, pad, or trigger) action.
 *
 * @see Controllers.analog
 */
export interface AnalogAction {
  /** Horizontal value. Range depends on `mode`: -1 to 1 for a joystick, a delta for a mouse-like source. */
  x: number;
  /** Vertical value, on the same scale as `x`. */
  y: number;
  /** EInputSourceMode, which says how to read `x` and `y` (joystick, trigger, mouse, and so on). */
  mode: number;
  /** True while the action is bound in the active action set. A false here makes `x` and `y` meaningless. */
  active: boolean;
}

/**
 * Task level wrapper over ISteamInput: controller handles, action sets,
 * action data, haptics, and the device callbacks.
 *
 * Steam Input maps every controller to the actions named in the app's action
 * manifest, so the flow is: `init`, `list` for the connected controllers,
 * `actionSet` and `digitalAction` / `analogAction` for the handles, then
 * `runFrame` plus `digital` / `analog` once per frame. All of it reads the
 * local Steam client, so nothing here awaits a call result. Reach it as
 * `steam.controllers`, since the generated interface already owns
 * `steam.input`.
 *
 * @see Steam.controllers
 */
export class Controllers {
  /**
   * @param input - The ISteamInput interface.
   * @param subscribe - Callback subscriber, normally `steam.on` bound to the session.
   */
  constructor(
    private readonly input: ISteamInput,
    private readonly subscribe: <K extends keyof SteamCallbackMap & string>(
      name: K,
      listener: (data: SteamCallbackMap[K]) => void,
    ) => () => void,
  ) {}

  /**
   * Starts Steam Input. Call this once before anything else here.
   *
   * @param explicitRunFrame - True to update the action data only when `runFrame` is called, which is what a game loop wants. False lets Steam update it on its own schedule.
   * @returns True if Steam Input started.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * steam.controllers.init(true);
   * console.log(steam.controllers.list());
   * steam.controllers.shutdown();
   * steam.close();
   * ```
   * @see shutdown
   */
  init(explicitRunFrame = false): boolean {
    return this.input.Init(explicitRunFrame);
  }

  /**
   * Stops Steam Input and releases the controller handles.
   *
   * @returns True if Steam Input shut down.
   * @see init
   */
  shutdown(): boolean {
    return this.input.Shutdown();
  }

  /**
   * Refreshes the action data for every controller.
   *
   * Call this once per frame when `init(true)` was used. Without it the values
   * from `digital`, `analog`, and `motion` never change.
   *
   * @see init
   */
  runFrame(): void {
    this.input.RunFrame(false);
  }

  /**
   * Lists the currently connected controllers.
   *
   * @returns One input handle per controller, at most 16. 64-bit, so `bigint`s. Empty if none is connected.
   * @see type
   */
  list(): bigint[] {
    const buffer = Buffer.alloc(MAX_CONTROLLERS * HANDLE_BYTES);
    const count = this.input.GetConnectedControllers(buffer);
    const handles: bigint[] = [];
    for (let i = 0; i < count; i++) handles.push(buffer.readBigUInt64LE(i * HANDLE_BYTES));
    return handles;
  }

  /**
   * Reads what kind of controller a handle belongs to.
   *
   * @param handle - Controller to read, from `list`. 64-bit, so a `bigint`.
   * @returns ESteamInputType (0 unknown, 2 Xbox 360, 3 Xbox One, 5 PS4, 13 PS5, 14 Steam Deck, and so on).
   * @see list
   */
  type(handle: bigint): number {
    return this.input.GetInputTypeForHandle(handle);
  }

  /**
   * Looks up the handle of an action set by the name in the action manifest.
   *
   * Handles never change while the app runs, so look them up once at startup.
   *
   * @param name - Action set name, exactly as in the manifest.
   * @returns The action set handle. 64-bit, so a `bigint`.
   * @throws Error if no action set carries that name.
   * @see activateActionSet
   */
  actionSet(name: string): bigint {
    const handle = this.input.GetActionSetHandle(name);
    if (handle === 0n) throw new Error(`steamwand: no action set named '${name}' in the action manifest`);
    return handle;
  }

  /**
   * Looks up the handle of a digital action by the name in the action manifest.
   *
   * @param name - Action name, exactly as in the manifest.
   * @returns The digital action handle. 64-bit, so a `bigint`.
   * @throws Error if no digital action carries that name.
   * @see digital
   */
  digitalAction(name: string): bigint {
    const handle = this.input.GetDigitalActionHandle(name);
    if (handle === 0n) throw new Error(`steamwand: no digital action named '${name}' in the action manifest`);
    return handle;
  }

  /**
   * Looks up the handle of an analog action by the name in the action manifest.
   *
   * @param name - Action name, exactly as in the manifest.
   * @returns The analog action handle. 64-bit, so a `bigint`.
   * @throws Error if no analog action carries that name.
   * @see analog
   */
  analogAction(name: string): bigint {
    const handle = this.input.GetAnalogActionHandle(name);
    if (handle === 0n) throw new Error(`steamwand: no analog action named '${name}' in the action manifest`);
    return handle;
  }

  /**
   * Makes one action set the active one for a controller.
   *
   * Only one action set is active at a time. Steam has no result for this, so
   * it cannot fail from here.
   *
   * @param handle - Controller to change, from `list`. 64-bit, so a `bigint`.
   * @param actionSet - Action set to activate, from `actionSet`. 64-bit, so a `bigint`.
   * @see currentActionSet
   */
  activateActionSet(handle: bigint, actionSet: bigint): void {
    this.input.ActivateActionSet(handle, actionSet);
  }

  /**
   * Reads the active action set of a controller.
   *
   * @param handle - Controller to read. 64-bit, so a `bigint`.
   * @returns The active action set handle, or `0n` if none is active.
   * @see activateActionSet
   */
  currentActionSet(handle: bigint): bigint {
    return this.input.GetCurrentActionSet(handle);
  }

  /**
   * Pushes an action set layer on top of the active action set.
   *
   * A layer overrides only the actions it binds and leaves the rest of the
   * action set alone. Layers stack, so this may be called more than once.
   *
   * @param handle - Controller to change. 64-bit, so a `bigint`.
   * @param layer - Action set layer to push, from `actionSet`. 64-bit, so a `bigint`.
   * @see deactivateActionSetLayer
   */
  activateActionSetLayer(handle: bigint, layer: bigint): void {
    this.input.ActivateActionSetLayer(handle, layer);
  }

  /**
   * Removes one action set layer.
   *
   * @param handle - Controller to change. 64-bit, so a `bigint`.
   * @param layer - Action set layer to remove. 64-bit, so a `bigint`.
   * @see activateActionSetLayer
   */
  deactivateActionSetLayer(handle: bigint, layer: bigint): void {
    this.input.DeactivateActionSetLayer(handle, layer);
  }

  /**
   * Removes every action set layer, leaving the action set itself active.
   *
   * @param handle - Controller to change. 64-bit, so a `bigint`.
   * @see activateActionSetLayer
   */
  deactivateAllActionSetLayers(handle: bigint): void {
    this.input.DeactivateAllActionSetLayers(handle);
  }

  /**
   * Reads the current state of a digital action.
   *
   * @param handle - Controller to read, from `list`. 64-bit, so a `bigint`.
   * @param action - Digital action to read, from `digitalAction`. 64-bit, so a `bigint`.
   * @returns Whether the action is pressed, and whether it is bound at all.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * steam.controllers.init(true);
   * const [pad] = steam.controllers.list();
   * const fire = steam.controllers.digitalAction('fire');
   * steam.controllers.runFrame();
   * if (pad && steam.controllers.digital(pad, fire).state) console.log('firing');
   * steam.close();
   * ```
   * @see digitalAction
   */
  digital(handle: bigint, action: bigint): DigitalAction {
    const data = this.input.GetDigitalActionData(handle, action);
    return { state: data.bState, active: data.bActive };
  }

  /**
   * Reads the current state of an analog action.
   *
   * @param handle - Controller to read, from `list`. 64-bit, so a `bigint`.
   * @param action - Analog action to read, from `analogAction`. 64-bit, so a `bigint`.
   * @returns The two axes, the source mode that says how to read them, and whether the action is bound.
   * @see analogAction
   */
  analog(handle: bigint, action: bigint): AnalogAction {
    const data = this.input.GetAnalogActionData(handle, action);
    return { x: data.x, y: data.y, mode: data.eMode, active: data.bActive };
  }

  /**
   * Reads the gyro and accelerometer of a controller.
   *
   * Only controllers with motion hardware (Steam Controller, Steam Deck,
   * DualShock, Switch pads) report anything; the rest return zeroes.
   *
   * @param handle - Controller to read, from `list`. 64-bit, so a `bigint`.
   * @returns The rotation quaternion, the acceleration, and the angular velocity.
   */
  motion(handle: bigint): InputMotionData_t {
    return this.input.GetMotionData(handle);
  }

  /**
   * Runs the two main rumble motors.
   *
   * Only reaches controllers with rumble hardware. The speeds hold until they
   * are set again, so pass zeroes to stop.
   *
   * @param handle - Controller to rumble. 64-bit, so a `bigint`.
   * @param leftSpeed - Speed of the left motor, 0 to 65535.
   * @param rightSpeed - Speed of the right motor, 0 to 65535.
   * @see vibrateExtended
   */
  vibrate(handle: bigint, leftSpeed: number, rightSpeed: number): void {
    this.input.TriggerVibration(handle, leftSpeed, rightSpeed);
  }

  /**
   * Runs the main motors and the trigger motors.
   *
   * The trigger speeds only reach controllers with trigger rumble, for example
   * the Xbox One and DualSense pads.
   *
   * @param handle - Controller to rumble. 64-bit, so a `bigint`.
   * @param leftSpeed - Speed of the left motor, 0 to 65535.
   * @param rightSpeed - Speed of the right motor, 0 to 65535.
   * @param leftTriggerSpeed - Speed of the left trigger motor, 0 to 65535.
   * @param rightTriggerSpeed - Speed of the right trigger motor, 0 to 65535.
   * @see vibrate
   */
  vibrateExtended(
    handle: bigint,
    leftSpeed: number,
    rightSpeed: number,
    leftTriggerSpeed: number,
    rightTriggerSpeed: number,
  ): void {
    this.input.TriggerVibrationExtended(handle, leftSpeed, rightSpeed, leftTriggerSpeed, rightTriggerSpeed);
  }

  /**
   * Plays one haptic click on a controller's haptic speakers.
   *
   * Steam Controller and Steam Deck hardware only. Everything else ignores it.
   *
   * @param handle - Controller to buzz. 64-bit, so a `bigint`.
   * @param location - EControllerHapticLocation (1 left, 2 right, 3 both).
   * @param intensity - Strength of the click, 0 to 255.
   * @param gainDb - Loudness offset in decibels, signed, normally between -25 and 6.
   * @param otherIntensity - Strength for the second pad when `location` is both.
   * @param otherGainDb - Loudness offset for the second pad when `location` is both.
   */
  triggerHaptic(
    handle: bigint,
    location: number,
    intensity: number,
    gainDb = 0,
    otherIntensity = 0,
    otherGainDb = 0,
  ): void {
    this.input.TriggerSimpleHapticEvent(handle, location, intensity, gainDb, otherIntensity, otherGainDb);
  }

  /**
   * Sets the color of a controller's LED.
   *
   * DualShock and DualSense hardware only. Steam has no result for this, so it
   * cannot fail from here.
   *
   * @param handle - Controller to light. 64-bit, so a `bigint`.
   * @param r - Red, 0 to 255.
   * @param g - Green, 0 to 255.
   * @param b - Blue, 0 to 255.
   * @param flags - ESteamInputLEDFlag (1 sets the color, 2 restores the user's default and ignores the color).
   * @defaultValue 1, which sets the color
   */
  setLedColor(handle: bigint, r: number, g: number, b: number, flags = 1): void {
    this.input.SetLEDColor(handle, r, g, b, flags);
  }

  /**
   * Opens the Steam overlay on the binding screen for a controller.
   *
   * Needs the Steam overlay, so it does nothing when the overlay is disabled
   * or the app runs outside Steam.
   *
   * @param handle - Controller whose bindings to show. 64-bit, so a `bigint`.
   * @returns True if the overlay opened.
   */
  showBindingPanel(handle: bigint): boolean {
    return this.input.ShowBindingPanel(handle);
  }

  /**
   * Returns the path of the PNG glyph for one input origin.
   *
   * The glyph is the button picture to show in a prompt, matching whatever
   * hardware the action is bound to right now. Origins come from
   * `steam.input.GetDigitalActionOrigins` and its analog twin.
   *
   * @param origin - EInputActionOrigin of the binding.
   * @param size - ESteamInputGlyphSize (0 small, 1 medium, 2 large).
   * @defaultValue medium
   * @returns Absolute path of a PNG file on disk, or an empty string if Steam has no glyph for that origin.
   * @see originName
   */
  glyphForOrigin(origin: number, size: number = ESteamInputGlyphSize.k_ESteamInputGlyphSize_Medium): string {
    return this.input.GetGlyphPNGForActionOrigin(origin, size, 0);
  }

  /**
   * Returns the human readable name of one input origin, for example `A Button`.
   *
   * @param origin - EInputActionOrigin of the binding.
   * @returns The name in the Steam client language, or an empty string if the origin is unknown.
   * @see glyphForOrigin
   */
  originName(origin: number): string {
    return this.input.GetStringForActionOrigin(origin);
  }

  /**
   * Turns on the device callbacks.
   *
   * Without this Steam never fires `SteamInputDeviceConnected_t`,
   * `SteamInputDeviceDisconnected_t`, or `SteamInputConfigurationLoaded_t`, so
   * `onConnected`, `onDisconnected`, and `onConfigurationLoaded` stay silent.
   * Steam has no way to turn them off again.
   *
   * @see onConnected
   */
  enableDeviceCallbacks(): void {
    this.input.EnableDeviceCallbacks();
  }

  /**
   * Subscribes to controllers being connected.
   *
   * Needs `enableDeviceCallbacks` first.
   *
   * @param listener - Runs with the input handle of the controller that appeared.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * steam.controllers.init(true);
   * steam.controllers.enableDeviceCallbacks();
   * const off = steam.controllers.onConnected((handle) => console.log('pad', handle));
   * // later: off(); steam.controllers.shutdown(); steam.close();
   * ```
   * @see onDisconnected
   */
  onConnected(listener: (handle: bigint) => void): () => void {
    return this.subscribe('SteamInputDeviceConnected_t', (e) => listener(e.m_ulConnectedDeviceHandle));
  }

  /**
   * Subscribes to controllers being disconnected.
   *
   * Needs `enableDeviceCallbacks` first.
   *
   * @param listener - Runs with the input handle of the controller that went away.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @see onConnected
   */
  onDisconnected(listener: (handle: bigint) => void): () => void {
    return this.subscribe('SteamInputDeviceDisconnected_t', (e) => listener(e.m_ulDisconnectedDeviceHandle));
  }

  /**
   * Subscribes to controller configurations being loaded.
   *
   * Fires when Steam applies a binding configuration to a controller, which
   * also happens on connect. The event says which device it was, who made the
   * configuration, and whether it drives the Steam Input or the gamepad API.
   * Needs `enableDeviceCallbacks` first.
   *
   * @param listener - Runs with the decoded `SteamInputConfigurationLoaded_t`.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @see enableDeviceCallbacks
   */
  onConfigurationLoaded(listener: (event: SteamInputConfigurationLoaded_t) => void): () => void {
    return this.subscribe('SteamInputConfigurationLoaded_t', listener);
  }
}
