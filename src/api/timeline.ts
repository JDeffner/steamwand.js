import type { SteamDispatch } from '../runtime/dispatch';
import type { ISteamTimeline } from '../generated/interfaces/ISteamTimeline';
import { layoutOf } from '../generated/structs';
import type {
  SteamTimelineEventRecordingExists_t,
  SteamTimelineGamePhaseRecordingExists_t,
} from '../generated/structs';
import { callbackIdByName } from '../generated/callbacks';
import { ETimelineEventClipPriority } from '../generated/enums';

/**
 * One marker on the Steam Game Recording timeline.
 *
 * @see Timeline.addEvent
 * @see Timeline.startEvent
 */
export interface TimelineEvent {
  /** Short label shown on the timeline, for example `Boss defeated`. */
  title: string;
  /** Longer text shown when the user hovers the marker. */
  description: string;
  /**
   * Steam icon name, for example `steam_achievement` or `steam_death`. Valve
   * lists the built-in names, and lets you upload your own, at
   * https://partner.steamgames.com/doc/features/timeline
   */
  icon: string;
  /** Ranks this event against others at the same moment. Higher wins the visible slot. */
  priority?: number;
  /** Seconds relative to now. Negative points into the past, for something you only detected afterwards. */
  startOffset?: number;
  /** Length of the event in seconds. Omit for an instant. */
  duration?: number;
  /** `ETimelineEventClipPriority`: 1 none, 2 standard, 3 featured. Tells Steam how worth clipping this is. */
  clipPriority?: number;
}

/**
 * What Steam recorded during one game phase.
 *
 * @see Timeline.phaseRecordingExists
 */
export interface PhaseRecording {
  /** The phase id that was asked about. */
  phaseId: string;
  /** Total recorded milliseconds for the phase. `0n` if nothing was recorded. */
  recordingMs: bigint;
  /** Length of the longest clip in milliseconds. 64-bit, so a `bigint`. */
  longestClipMs: bigint;
  /** Number of clips the user saved from the phase. */
  clipCount: number;
  /** Number of screenshots taken during the phase. */
  screenshotCount: number;
}

/**
 * Task level wrapper over ISteamTimeline: mark what happened during Steam Game
 * Recording, so the user can find the interesting moments again.
 *
 * Every marking call is fire and forget. Steam has no result for them, and a
 * user with Game Recording turned off silently records nothing, so nothing
 * here throws for that. The event handles still come back, they just refer to
 * a recording that does not exist; `eventRecordingExists` is how you find out.
 *
 * An *event* is a moment (or a range) worth clipping. A *phase* is a longer
 * stretch of play, for example one match or one dungeon, that carries tags and
 * attributes and that the user can jump to in the overlay.
 *
 * Reach it as `steam.recording`. Named `recording` because the generated
 * ISteamTimeline accessor already owns `steam.timeline`.
 *
 * @see Steam.recording
 */
export class Timeline {
  /**
   * @param timeline - The ISteamTimeline interface.
   * @param dispatch - Running pump that resolves the call results.
   */
  constructor(
    private readonly timeline: ISteamTimeline,
    private readonly dispatch: SteamDispatch,
  ) {}

  /**
   * Sets the text shown when the user hovers the timeline at this moment.
   *
   * Steam keeps the tooltip until it is changed or cleared, so this is state,
   * not an event: call it when the situation changes, not every frame.
   *
   * @param text - Tooltip text.
   * @param timeDelta - Seconds relative to now the tooltip applies from. Negative points into the past.
   * @defaultValue 0
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * steam.recording.setTooltip('Level 3, 2 lives left');
   * steam.close();
   * ```
   * @see clearTooltip
   */
  setTooltip(text: string, timeDelta = 0): void {
    this.timeline.SetTimelineTooltip(text, timeDelta);
  }

  /**
   * Removes the tooltip set with `setTooltip`.
   *
   * @param timeDelta - Seconds relative to now the tooltip stops applying from.
   * @defaultValue 0
   * @see setTooltip
   */
  clearTooltip(timeDelta = 0): void {
    this.timeline.ClearTimelineTooltip(timeDelta);
  }

  /**
   * Tells Steam what the player is doing right now.
   *
   * Steam colours the timeline bar by mode, so a menu or a loading screen is
   * visibly not gameplay. Set it whenever the game changes state.
   *
   * @param mode - `ETimelineGameMode`: 1 playing, 2 staging, 3 menus, 4 loading screen.
   * @example
   * ```ts
   * import { init, flat } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * steam.recording.setGameMode(flat.ETimelineGameMode.k_ETimelineGameMode_Playing);
   * steam.close();
   * ```
   */
  setGameMode(mode: number): void {
    this.timeline.SetTimelineGameMode(mode);
  }

  /**
   * Marks one event on the timeline and returns its handle.
   *
   * Instantaneous without `duration`, a range with it. Use this when the event
   * is over by the time you know about it; for something that is still running,
   * use `startEvent`.
   *
   * @param event - Title, description, icon, and the optional priority, offset, duration and clip priority.
   * @returns The event handle, for `updateEvent`, `removeEvent` and `eventRecordingExists`. 64-bit, so a `bigint`. `0n` when Steam did not record an event, for example because the user has Game Recording off.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const id = steam.recording.addEvent({
   *   title: 'Boss defeated',
   *   description: 'Beat the first boss without dying',
   *   icon: 'steam_achievement',
   * });
   * steam.close();
   * ```
   * @see startEvent
   */
  addEvent(event: TimelineEvent): bigint {
    const clip = event.clipPriority ?? ETimelineEventClipPriority.k_ETimelineEventClipPriority_Standard;
    const priority = event.priority ?? 0;
    const start = event.startOffset ?? 0;
    if (event.duration === undefined) {
      return this.timeline.AddInstantaneousTimelineEvent(
        event.title,
        event.description,
        event.icon,
        priority,
        start,
        clip,
      );
    }
    return this.timeline.AddRangeTimelineEvent(
      event.title,
      event.description,
      event.icon,
      priority,
      start,
      event.duration,
      clip,
    );
  }

  /**
   * Opens an event whose end is not known yet.
   *
   * The event stays open until `endEvent`, and Steam ends any still-open event
   * when the game exits. Change its text while it runs with `updateEvent`, for
   * example to count the kills in a fight that is still going.
   *
   * @param event - The same fields as `addEvent`, without `duration`.
   * @returns The event handle. 64-bit, so a `bigint`.
   * @example
   * ```ts
   * const fight = steam.recording.startEvent({
   *   title: 'Boss fight',
   *   description: 'Fighting the first boss',
   *   icon: 'steam_combat',
   * });
   * // later:
   * steam.recording.endEvent(fight);
   * ```
   * @see endEvent
   * @see updateEvent
   */
  startEvent(event: Omit<TimelineEvent, 'duration'>): bigint {
    return this.timeline.StartRangeTimelineEvent(
      event.title,
      event.description,
      event.icon,
      event.priority ?? 0,
      event.startOffset ?? 0,
      event.clipPriority ?? ETimelineEventClipPriority.k_ETimelineEventClipPriority_Standard,
    );
  }

  /**
   * Replaces the text, icon and priorities of an open event.
   *
   * Every field is sent, so pass the whole event, not only what changed.
   *
   * @param id - Handle from `startEvent`. 64-bit, so a `bigint`.
   * @param event - The new title, description, icon, priority and clip priority.
   * @see startEvent
   */
  updateEvent(id: bigint, event: Omit<TimelineEvent, 'startOffset' | 'duration'>): void {
    this.timeline.UpdateRangeTimelineEvent(
      id,
      event.title,
      event.description,
      event.icon,
      event.priority ?? 0,
      event.clipPriority ?? ETimelineEventClipPriority.k_ETimelineEventClipPriority_Standard,
    );
  }

  /**
   * Closes an event opened with `startEvent`.
   *
   * @param id - Handle from `startEvent`. 64-bit, so a `bigint`.
   * @param endOffset - Seconds relative to now the event ended. Negative points into the past.
   * @defaultValue 0
   * @see startEvent
   */
  endEvent(id: bigint, endOffset = 0): void {
    this.timeline.EndRangeTimelineEvent(id, endOffset);
  }

  /**
   * Deletes an event from the timeline.
   *
   * For an event that turned out not to matter, for example a fight the player
   * ran away from.
   *
   * @param id - Handle from `addEvent` or `startEvent`. 64-bit, so a `bigint`.
   */
  removeEvent(id: bigint): void {
    this.timeline.RemoveTimelineEvent(id);
  }

  /**
   * Asks whether Steam actually recorded video around one event.
   *
   * False for every event when the user has Game Recording off, and false for
   * an event outside the recording buffer. This is how a game decides whether
   * to offer the user a clip.
   *
   * @param id - Handle from `addEvent` or `startEvent`. 64-bit, so a `bigint`.
   * @returns True if a recording covers the event.
   * @throws SteamApiCallError if the call could not be completed.
   * @see addEvent
   */
  async eventRecordingExists(id: bigint): Promise<boolean> {
    const call = this.timeline.DoesEventRecordingExist(id);
    const r = await this.dispatch.callResultStruct<SteamTimelineEventRecordingExists_t>(
      call,
      layoutOf('SteamTimelineEventRecordingExists_t'),
      callbackIdByName.SteamTimelineEventRecordingExists_t,
    );
    return r.m_bRecordingExists;
  }

  /**
   * Starts a game phase.
   *
   * A phase is a stretch of play the user can jump to later, for example one
   * match or one run. Tags and attributes set while it is open belong to it.
   * Starting a phase ends the one before it.
   *
   * @example
   * ```ts
   * steam.recording.startPhase();
   * steam.recording.setPhaseId('match-4711');
   * steam.recording.addPhaseTag('Dust II', 'steam_map', 'Map');
   * // ... play ...
   * steam.recording.endPhase();
   * ```
   * @see endPhase
   * @see setPhaseId
   */
  startPhase(): void {
    this.timeline.StartGamePhase();
  }

  /**
   * Ends the open game phase.
   *
   * @see startPhase
   */
  endPhase(): void {
    this.timeline.EndGamePhase();
  }

  /**
   * Gives the open phase an id of your own.
   *
   * Steam stores at most 64 bytes of it. Use an id your game can recognise
   * later, because it is what `phaseRecordingExists` and `openOverlayToPhase`
   * take. Two phases may share an id, which groups them.
   *
   * @param id - Your phase id, at most 63 UTF-8 bytes plus the terminator.
   * @see phaseRecordingExists
   */
  setPhaseId(id: string): void {
    this.timeline.SetGamePhaseID(id);
  }

  /**
   * Adds a tag to the open phase.
   *
   * Tags are the facts about a phase that repeat, for example the map, the
   * character, or the game mode. Steam groups them by `group` in the UI.
   *
   * @param name - Tag text, for example `Dust II`.
   * @param icon - Steam icon name for the tag.
   * @param group - Group the tag is shown under, for example `Map`.
   * @param priority - Ranks this tag against others in the same group. Higher shows first.
   * @defaultValue 0
   * @see setPhaseAttribute
   */
  addPhaseTag(name: string, icon: string, group: string, priority = 0): void {
    this.timeline.AddGamePhaseTag(name, icon, group, priority);
  }

  /**
   * Sets one attribute of the open phase.
   *
   * An attribute is a single value per group, not a list, so setting it again
   * with the same group replaces it. Use it for things like the final score.
   *
   * @param group - Attribute name, for example `Score`.
   * @param value - Attribute value, for example `16-14`.
   * @param priority - Ranks this attribute against others. Higher shows first.
   * @defaultValue 0
   * @see addPhaseTag
   */
  setPhaseAttribute(group: string, value: string, priority = 0): void {
    this.timeline.SetGamePhaseAttribute(group, value, priority);
  }

  /**
   * Asks what Steam recorded during a phase.
   *
   * All counters are zero when the user has Game Recording off, or when no
   * phase ever carried that id, so this never fails for an unknown phase: it
   * answers with an empty recording.
   *
   * @param phaseId - The id given to `setPhaseId`.
   * @returns Recorded length, longest clip, and the clip and screenshot counts.
   * @throws SteamApiCallError if the call could not be completed.
   * @example
   * ```ts
   * const r = await steam.recording.phaseRecordingExists('match-4711');
   * if (r.recordingMs > 0n) steam.recording.openOverlayToPhase('match-4711');
   * ```
   * @see setPhaseId
   */
  async phaseRecordingExists(phaseId: string): Promise<PhaseRecording> {
    const call = this.timeline.DoesGamePhaseRecordingExist(phaseId);
    const r = await this.dispatch.callResultStruct<SteamTimelineGamePhaseRecordingExists_t>(
      call,
      layoutOf('SteamTimelineGamePhaseRecordingExists_t'),
      callbackIdByName.SteamTimelineGamePhaseRecordingExists_t,
    );
    return {
      phaseId: r.m_rgchPhaseID,
      recordingMs: r.m_ulRecordingMS,
      longestClipMs: r.m_ulLongestClipMS,
      clipCount: r.m_unClipCount,
      screenshotCount: r.m_unScreenshotCount,
    };
  }

  /**
   * Opens the Steam overlay on a phase.
   *
   * The overlay draws into the game's own renderer, so a plain Node process
   * gets nothing from this. Same caveat as the whole `steam.overlay` layer.
   *
   * @param id - The id given to `setPhaseId`.
   * @see Overlay
   */
  openOverlayToPhase(id: string): void {
    this.timeline.OpenOverlayToGamePhase(id);
  }

  /**
   * Opens the Steam overlay on one event, where the user can save a clip of it.
   *
   * @param id - Handle from `addEvent` or `startEvent`. 64-bit, so a `bigint`.
   * @see openOverlayToPhase
   */
  openOverlayToEvent(id: bigint): void {
    this.timeline.OpenOverlayToTimelineEvent(id);
  }
}
