import { ReactiveStore, Tracer, ftch, type LunaUnload } from "@luna/core";
import { MediaItem, redux } from "@luna/lib";

export const { trace } = Tracer("[Hunminjeongeum]");
export const unloads = new Set<LunaUnload>();

type ItemId = string | number;
type Track = {
	id: ItemId;
	title: string;
	isrc?: string | null;
	artist?: { name?: string | null };
	artists?: Array<{ name?: string | null }>;
};
type ReduxMediaItem = { type: "track" | "video"; item: Track };
type SearchTopHit = { type: "TRACKS"; value: Track } | { type: string; value: any };
type SearchResultPayload = {
	tracks: { items: Track[] };
	topHits?: SearchTopHit;
};

export type HunminjeongeumStorage = {
	enabled: boolean;
	/**
	 * Cached translations by ISRC (uppercased).
	 */
	cache: Record<string, string>;
	/**
	 * Cached "not found" ISRCs (uppercased) with last miss timestamp (ms).
	 */
	misses: Record<string, number>;
	/**
	 * Manual overrides.
	 * - ISRC override key: "ISRC:KRxxx..."
	 * - Title override key: "TITLE:lowercased title||lowercased artist"
	 */
	overrides: Record<string, string>;
};

const defaultStorage: HunminjeongeumStorage = {
	enabled: true,
	cache: {},
	misses: {},
	overrides: {
		// Example:
		// "ISRC:KRXXXXXX0001": "라일락",
		// "TITLE:lilac||iu": "라일락",
	},
};

export let storage: HunminjeongeumStorage = { ...defaultStorage };

const loadStorage = async () => {
	try {
		storage = await ReactiveStore.getPluginStorage<HunminjeongeumStorage>("Hunminjeongeum", defaultStorage);
	} catch (err) {
		trace.err.withContext("getPluginStorage")(err);
		storage = { ...defaultStorage };
	}
};

await loadStorage();

const HANGUL_RE = /[\uac00-\ud7a3]/;
const hasHangul = (value?: string | null) => (value ? HANGUL_RE.test(value) : false);

const normalizeKey = (title: string, artist?: string | null) => {
	const base = title.trim().toLowerCase();
	const artistPart = (artist ?? "").trim().toLowerCase();
	return `TITLE:${base}||${artistPart}`;
};

const getArtistName = (track: Track) => track.artist?.name ?? track.artists?.[0]?.name ?? "";

const getOverrideTitle = (track: Track) => {
	const isrc = (track.isrc ?? "").trim();
	if (isrc) {
		const byIsrc = storage.overrides[`ISRC:${isrc.toUpperCase()}`];
		if (byIsrc) return byIsrc;
	}
	const key = normalizeKey(track.title, getArtistName(track));
	return storage.overrides[key];
};

const getCachedTitle = (track: Track) => {
	const isrc = (track.isrc ?? "").trim().toUpperCase();
	if (!isrc) return undefined;
	return storage.cache[isrc];
};

const MISS_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const isFreshMiss = (isrc: string) => {
	const lastMiss = storage.misses[isrc];
	if (!lastMiss) return false;
	if (Date.now() - lastMiss < MISS_TTL_MS) return true;
	delete storage.misses[isrc];
	return false;
};

const shouldAttemptLookup = (track: Track) => {
	if (!storage.enabled) return false;
	if (!track?.title) return false;
	if (hasHangul(track.title)) return false;
	const isrc = (track.isrc ?? "").trim();
	if (!isrc) return false;
	if (isFreshMiss(isrc.toUpperCase())) return false;
	if (hasHangul(getArtistName(track))) return true;
	return isrc.toUpperCase().startsWith("KR");
};

const applyCachedTitle = (track: Track) => {
	const override = getOverrideTitle(track);
	if (override && override !== track.title) {
		track.title = override;
		return true;
	}
	const cached = getCachedTitle(track);
	if (cached && cached !== track.title) {
		track.title = cached;
		return true;
	}
	return false;
};

const observedTracksByIsrc = new Map<string, Set<Track>>();
const observedTracksById = new Map<ItemId, Set<Track>>();
const feedTrackIds = new Set<ItemId>();
const feedIsrcs = new Set<string>();
let lastFeedPayload: unknown | null = null;
let feedRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let isReplayingFeed = false;

const registerTrackRef = (track: Track) => {
	if (!track) return;
	const id = track.id;
	if (id !== undefined && id !== null) {
		const byId = observedTracksById.get(id) ?? new Set<Track>();
		byId.add(track);
		observedTracksById.set(id, byId);
	}
	const isrc = (track.isrc ?? "").trim().toUpperCase();
	if (!isrc) return;
	const byIsrc = observedTracksByIsrc.get(isrc) ?? new Set<Track>();
	byIsrc.add(track);
	observedTracksByIsrc.set(isrc, byIsrc);
};

const broadcastTitleUpdate = (trackId: ItemId | undefined, isrc: string | undefined, title: string) => {
	const seen = new Set<Track>();
	if (trackId !== undefined && trackId !== null) {
		const byId = observedTracksById.get(trackId);
		if (byId) for (const track of byId) seen.add(track);
	}
	if (isrc) {
		const byIsrc = observedTracksByIsrc.get(isrc);
		if (byIsrc) for (const track of byIsrc) seen.add(track);
	}
	seen.forEach((track) => {
		if (track.title !== title) track.title = title;
	});
	const inFeed = (trackId !== undefined && trackId !== null && feedTrackIds.has(trackId)) || (!!isrc && feedIsrcs.has(isrc));
	if (inFeed) scheduleFeedRefresh();
};

const scheduleFeedRefresh = () => {
	if (!lastFeedPayload || isReplayingFeed) return;
	if (feedRefreshTimer) return;
	feedRefreshTimer = setTimeout(() => {
		feedRefreshTimer = null;
		if (!lastFeedPayload || isReplayingFeed) return;
		isReplayingFeed = true;
		try {
			redux.actions["feed/LOAD_FEED_SUCCESS"](lastFeedPayload as any);
		} finally {
			isReplayingFeed = false;
		}
	}, 50);
};

const isTrackLike = (value: unknown): value is Track => {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	const hasId = typeof item.id === "string" || typeof item.id === "number";
	const hasTitle = typeof item.title === "string";
	if (!hasId || !hasTitle) return false;
	const type = String(item.type ?? item.itemType ?? item.mediaType ?? "").toLowerCase();
	if (type === "track") return true;
	const isrc = typeof item.isrc === "string" ? item.isrc.trim() : "";
	return isrc.length > 0;
};

const collectTracks = (root: unknown) => {
	const tracks: Track[] = [];
	const seen = new Set<unknown>();
	const seenIds = new Set<ItemId>();
	const queue: unknown[] = [root];
	let steps = 0;
	while (queue.length > 0 && steps < 3000) {
		const current = queue.shift();
		steps += 1;
		if (!current || typeof current !== "object") continue;
		if (seen.has(current)) continue;
		seen.add(current);
		if (isTrackLike(current)) {
			const track = current as Track;
			if (!seenIds.has(track.id)) {
				tracks.push(track);
				seenIds.add(track.id);
			}
		}
		if (Array.isArray(current)) {
			for (const value of current) queue.push(value);
			continue;
		}
		for (const value of Object.values(current as Record<string, unknown>)) {
			if (value && typeof value === "object") queue.push(value);
		}
	}
	return tracks;
};

const updateMediaItemTitleInStore = (trackId: ItemId, title: string) => {
	const mediaItem = redux.store.getState().content.mediaItems[String(trackId)];
	if (!mediaItem || mediaItem.type !== "track") return;
	if (mediaItem.item.title === title) return;
	const updated: ReduxMediaItem = {
		...mediaItem,
		item: { ...mediaItem.item, title },
	};
	redux.actions["content/LOAD_SINGLE_MEDIA_ITEM_SUCCESS"]({ mediaItem: updated });
};

let lastSearchPayload: SearchResultPayload | null = null;
const updateSearchResultsTitle = (trackId: ItemId, title: string) => {
	if (!lastSearchPayload) return;
	let changed = false;
	const nextTracks = lastSearchPayload.tracks.items.map((track) => {
		if (track.id !== trackId) return track;
		if (track.title === title) return track;
		changed = true;
		return { ...track, title };
	});
	if (!changed) return;
	const nextPayload: SearchResultPayload = {
		...lastSearchPayload,
		tracks: { ...lastSearchPayload.tracks, items: nextTracks },
	};
	lastSearchPayload = nextPayload;
	redux.actions["search/SEARCH_RESULT_SUCCESS"](nextPayload);
};

type MusicBrainzIsrcResponse = {
	recordings?: Array<{
		id: string;
		title: string;
		aliases?: Array<{ name: string; locale?: string | null; primary?: boolean }>;
	}>;
};

const pickHangulTitle = (titles: Array<string | undefined>) => titles.find((title) => title && hasHangul(title)) ?? null;

let requestQueue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;
const enqueueRequest = async <T>(run: () => Promise<T>) => {
	const task = async () => {
		const now = Date.now();
		const waitMs = Math.max(0, 1100 - (now - lastRequestAt));
		if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
		lastRequestAt = Date.now();
		return run();
	};
	const queued = requestQueue.then(task, task);
	requestQueue = queued.then(
		() => undefined,
		() => undefined,
	);
	return queued;
};

const fetchTitleFromMusicBrainz = async (isrc: string): Promise<string | null> => {
	const url = `https://musicbrainz.org/ws/2/isrc/${encodeURIComponent(isrc)}?fmt=json`;
	const data = await enqueueRequest(() => ftch.json<MusicBrainzIsrcResponse>(url));
	const recordings = data?.recordings ?? [];
	if (recordings.length === 0) return null;

	const direct = pickHangulTitle(recordings.map((rec) => rec.title));
	if (direct) return direct;

	const aliasTitle = pickHangulTitle(
		recordings.flatMap((rec) => rec.aliases?.map((alias) => alias.name) ?? []),
	);
	if (aliasTitle) return aliasTitle;
	return null;
};

const isNotFoundError = (err: unknown) => err instanceof Error && err.message.startsWith("404");

const pendingLookups = new Map<string, Promise<string | null>>();
const scheduleLookup = (track: Track) => {
	if (!shouldAttemptLookup(track)) return;
	const isrc = (track.isrc ?? "").trim().toUpperCase();
	if (!isrc) return;
	if (pendingLookups.has(isrc)) return;
	const task = (async () => {
		try {
			const title = await fetchTitleFromMusicBrainz(isrc);
			if (!title) return null;
			if (!storage.cache[isrc]) storage.cache[isrc] = title;
			broadcastTitleUpdate(track.id, isrc, title);
			updateMediaItemTitleInStore(track.id, title);
			updateSearchResultsTitle(track.id, title);
			return title;
		} catch (err) {
			if (isNotFoundError(err)) {
				storage.misses[isrc] = Date.now();
				return null;
			}
			trace.warn.withContext("musicbrainz")(err);
			return null;
		}
	})();
	pendingLookups.set(isrc, task);
	task.finally(() => pendingLookups.delete(isrc));
};

const handleTrack = (track: Track) => {
	if (!track || !storage.enabled) return;
	registerTrackRef(track);
	const changed = applyCachedTitle(track);
	if (!changed) scheduleLookup(track);
};

const handleMediaItem = (mediaItem: ReduxMediaItem) => {
	if (!mediaItem || mediaItem.type !== "track") return;
	handleTrack(mediaItem.item as Track);
};

const handleFeedPayload = (payload: unknown, markAsFeed = false) => {
	if (markAsFeed) lastFeedPayload = payload;
	const tracks = collectTracks(payload);
	if (tracks.length === 0) {
		if (markAsFeed) {
			feedTrackIds.clear();
			feedIsrcs.clear();
		}
		return;
	}
	if (markAsFeed) {
		feedTrackIds.clear();
		feedIsrcs.clear();
		tracks.forEach((track) => {
			feedTrackIds.add(track.id);
			const isrc = (track.isrc ?? "").trim().toUpperCase();
			if (isrc) feedIsrcs.add(isrc);
		});
	}
	tracks.forEach(handleTrack);
};

redux.intercept(
		[
			"content/LOAD_SINGLE_MEDIA_ITEM_SUCCESS",
			"content/LOAD_ALL_ALBUM_MEDIA_ITEMS_SUCCESS",
			"content/LOAD_ALL_ALBUM_MEDIA_ITEMS_WITH_CREDITS_SUCCESS",
			"content/LOAD_PLAYLIST_SUGGESTED_MEDIA_ITEMS_SUCCESS",
			"content/LOAD_PLAYLIST_SUCCESS",
			"content/LOAD_LIST_ITEMS_PAGE_SUCCESS",
			"content/LOAD_SUGGESTIONS_SUCCESS",
			"content/RECEIVED_FULL_TRACK_LIST_MEDIA_ITEMS",
			"content/LAZY_LOAD_MEDIA_ITEMS_SUCCESS",
			"content/LOAD_RECENT_ACTIVITY_SUCCESS",
			"content/LOAD_DYNAMIC_PAGE_SUCCESS",
		"route/LOADER_DATA__HOME--SUCCESS",
		"feed/LOAD_FEED_SUCCESS",
	],
	unloads,
	(payload, type) => {
		switch (type) {
			case "content/LOAD_SINGLE_MEDIA_ITEM_SUCCESS":
				handleMediaItem(payload.mediaItem);
				break;
			case "content/LOAD_ALL_ALBUM_MEDIA_ITEMS_SUCCESS":
			case "content/LOAD_ALL_ALBUM_MEDIA_ITEMS_WITH_CREDITS_SUCCESS":
				payload.mediaItems.forEach(handleMediaItem);
				break;
			case "content/LOAD_PLAYLIST_SUGGESTED_MEDIA_ITEMS_SUCCESS":
			case "content/LOAD_SUGGESTIONS_SUCCESS":
				payload.mediaItems.forEach(handleMediaItem);
				break;
			case "content/LOAD_PLAYLIST_SUCCESS":
			case "content/LOAD_LIST_ITEMS_PAGE_SUCCESS":
				handleFeedPayload(payload);
				break;
			case "content/RECEIVED_FULL_TRACK_LIST_MEDIA_ITEMS":
				payload.items.forEach(handleMediaItem);
				break;
			case "content/LAZY_LOAD_MEDIA_ITEMS_SUCCESS":
				if (payload?.items) Object.values(payload.items).forEach(handleMediaItem);
				break;
			case "content/LOAD_RECENT_ACTIVITY_SUCCESS":
			case "content/LOAD_DYNAMIC_PAGE_SUCCESS":
			case "route/LOADER_DATA__HOME--SUCCESS":
				handleFeedPayload(payload);
				break;
			case "feed/LOAD_FEED_SUCCESS":
				handleFeedPayload(payload, true);
				break;
			default:
				break;
		}
	},
);

redux.intercept("search/SEARCH_RESULT_SUCCESS", unloads, (payload) => {
	lastSearchPayload = payload;
	payload.tracks.items.forEach(handleTrack);
	if (payload.topHits?.type === "TRACKS") handleTrack(payload.topHits.value);
});

MediaItem.onMediaTransition(unloads, async (item) => {
	const track = item?.tidalItem as Track | undefined;
	if (!track) return;
	const override = getOverrideTitle(track);
	const cached = getCachedTitle(track);
	const next = override ?? cached;
	if (next && next !== track.title) {
		updateMediaItemTitleInStore(track.id, next);
	} else {
		scheduleLookup(track);
	}
});
