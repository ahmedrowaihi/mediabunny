import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { DASH_FORMATS } from '../../src/input-format.js';
import { BlobSource, CustomPathedSource } from '../../src/source.js';

/**
 * Build a CustomPathedSource that serves a single MPD body for any
 * `isRoot: true` request and throws otherwise. We never reach segments
 * here — these tests only assert metadata derived from the MPD itself.
 */
const mpdSource = (mpd: string): CustomPathedSource =>
	new CustomPathedSource('test://manifest.mpd', ({ isRoot }) => {
		if (!isRoot) {
			throw new Error('segment fetch not expected in metadata-only test');
		}
		return new BlobSource(new Blob([mpd], { type: 'application/dash+xml' }));
	});

const STATIC_MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
	type="static"
	mediaPresentationDuration="PT30S"
	profiles="urn:mpeg:dash:profile:isoff-live:2011">
	<Period id="p0" duration="PT30S">
		<AdaptationSet id="1" contentType="video" mimeType="video/mp4" codecs="avc1.640028">
			<SegmentTemplate
				media="$RepresentationID$/seg-$Number$.m4s"
				initialization="$RepresentationID$/init.mp4"
				timescale="90000" duration="180000" startNumber="1"/>
			<Representation id="v720" bandwidth="2500000" width="1280" height="720"/>
			<Representation id="v360" bandwidth="800000" width="640" height="360"/>
		</AdaptationSet>
		<AdaptationSet id="2" contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.2" lang="en">
			<Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>
			<SegmentTemplate
				media="audio/seg-$Number$.m4s"
				initialization="audio/init.mp4"
				timescale="48000" duration="96000" startNumber="1"/>
			<Representation id="a128" bandwidth="128000" audioSamplingRate="48000"/>
		</AdaptationSet>
	</Period>
</MPD>`;

test('Input + DASH_FORMATS: detects MPD and lists tracks from metadata', async () => {
	const input = new Input({
		source: mpdSource(STATIC_MPD),
		formats: DASH_FORMATS,
	});

	const format = await input.getFormat();
	expect(format.name).toContain('DASH');

	const tracks = await input.getTracks();
	// 2 video reps + 1 audio rep
	expect(tracks).toHaveLength(3);

	const videoTracks = await input.getVideoTracks();
	expect(videoTracks).toHaveLength(2);

	const audioTracks = await input.getAudioTracks();
	expect(audioTracks).toHaveLength(1);
});

test('Input + DASH_FORMATS: bitrate/resolution/codec come from MPD without segment fetch', async () => {
	const input = new Input({
		source: mpdSource(STATIC_MPD),
		formats: DASH_FORMATS,
	});

	const videoTracks = await input.getVideoTracks();
	const videoWithBitrate = await Promise.all(
		videoTracks.map(async t => ({ track: t, bitrate: await t.getBitrate() })),
	);

	const v720 = videoWithBitrate.find(x => x.bitrate === 2500000)!.track;
	expect(await v720.getBitrate()).toBe(2500000);
	expect(await v720.getCodec()).toBe('avc');
	expect(await v720.getCodecParameterString()).toBe('avc1.640028');
	expect(await v720.getDisplayWidth()).toBe(1280);
	expect(await v720.getDisplayHeight()).toBe(720);

	const v360 = videoWithBitrate.find(x => x.bitrate === 800000)!.track;
	expect(await v360.getDisplayWidth()).toBe(640);
	expect(await v360.getDisplayHeight()).toBe(360);

	const audio = (await input.getAudioTracks())[0]!;
	expect(await audio.getBitrate()).toBe(128000);
	expect(await audio.getCodec()).toBe('aac');
	expect(await audio.getLanguageCode()).toBe('en');
	expect(await audio.getSampleRate()).toBe(48000);
});

test('Input + DASH_FORMATS: tracks within the same Period are pairable', async () => {
	const input = new Input({
		source: mpdSource(STATIC_MPD),
		formats: DASH_FORMATS,
	});

	const videoTracks = await input.getVideoTracks();
	const audioTracks = await input.getAudioTracks();

	expect(videoTracks[0]!.canBePairedWith(audioTracks[0]!)).toBe(true);
	expect(videoTracks[1]!.canBePairedWith(audioTracks[0]!)).toBe(true);
});

test('Input + DASH_FORMATS: multi-period yields separate pairing groups', async () => {
	const mpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT60S">
	<Period id="ad" duration="PT15S">
		<AdaptationSet id="1" contentType="video" mimeType="video/mp4" codecs="avc1.42c01e">
			<SegmentTemplate media="ad-$Number$.m4s" timescale="90000" duration="180000"/>
			<Representation id="ad-v" bandwidth="2000000" width="1280" height="720"/>
		</AdaptationSet>
		<AdaptationSet id="2" contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.2">
			<SegmentTemplate media="ad-a-$Number$.m4s" timescale="48000" duration="96000"/>
			<Representation id="ad-a" bandwidth="96000"/>
		</AdaptationSet>
	</Period>
	<Period id="main" duration="PT45S">
		<AdaptationSet id="1" contentType="video" mimeType="video/mp4" codecs="avc1.640028">
			<SegmentTemplate media="main-$Number$.m4s" timescale="90000" duration="180000"/>
			<Representation id="main-v" bandwidth="5000000" width="1920" height="1080"/>
		</AdaptationSet>
		<AdaptationSet id="2" contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.2">
			<SegmentTemplate media="main-a-$Number$.m4s" timescale="48000" duration="96000"/>
			<Representation id="main-a" bandwidth="128000"/>
		</AdaptationSet>
	</Period>
</MPD>`;

	const input = new Input({ source: mpdSource(mpd), formats: DASH_FORMATS });
	const videoTracks = await input.getVideoTracks();
	const audioTracks = await input.getAudioTracks();

	expect(videoTracks).toHaveLength(2);
	expect(audioTracks).toHaveLength(2);

	const videoWithBitrate = await Promise.all(
		videoTracks.map(async t => ({ track: t, bitrate: await t.getBitrate() })),
	);
	const audioWithBitrate = await Promise.all(
		audioTracks.map(async t => ({ track: t, bitrate: await t.getBitrate() })),
	);

	const adVideo = videoWithBitrate.find(x => x.bitrate === 2000000)!.track;
	const mainVideo = videoWithBitrate.find(x => x.bitrate === 5000000)!.track;
	const adAudio = audioWithBitrate.find(x => x.bitrate === 96000)!.track;
	const mainAudio = audioWithBitrate.find(x => x.bitrate === 128000)!.track;

	// Within-period: pairable
	expect(adVideo.canBePairedWith(adAudio)).toBe(true);
	expect(mainVideo.canBePairedWith(mainAudio)).toBe(true);

	// Across periods: NOT pairable
	expect(adVideo.canBePairedWith(mainAudio)).toBe(false);
	expect(mainVideo.canBePairedWith(adAudio)).toBe(false);
});

test('Input + DASH_FORMATS: static MPD reports non-live', async () => {
	const input = new Input({ source: mpdSource(STATIC_MPD), formats: DASH_FORMATS });
	const video = (await input.getVideoTracks())[0]!;
	expect(await video.isLive()).toBe(false);
	expect(await video.getLiveRefreshInterval()).toBeNull();
});

test('Input + DASH_FORMATS: dynamic MPD reports live + refresh interval', async () => {
	const mpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
	type="dynamic"
	availabilityStartTime="2026-01-01T00:00:00Z"
	minimumUpdatePeriod="PT5S"
	publishTime="2026-01-01T00:00:05Z">
	<Period id="p0">
		<AdaptationSet id="1" contentType="video" mimeType="video/mp4" codecs="avc1.42c01e">
			<SegmentTemplate media="v-$Number$.m4s" timescale="90000" duration="180000"/>
			<Representation id="v1" bandwidth="1000000" width="640" height="360"/>
		</AdaptationSet>
	</Period>
</MPD>`;
	const input = new Input({ source: mpdSource(mpd), formats: DASH_FORMATS });
	const video = (await input.getVideoTracks())[0]!;
	expect(await video.isLive()).toBe(true);
	expect(await video.getLiveRefreshInterval()).toBe(5);
});

// Guards the wall-clock date-time adoption (upstream 1.49 unixEpochTimestamp model):
// dynamic MPDs with availabilityStartTime carry a Unix time per segment, static do not.
test('Input + DASH_FORMATS: getUnixTimeForTimestamp — wall-clock dynamic vs static', async () => {
	const staticInput = new Input({ source: mpdSource(STATIC_MPD), formats: DASH_FORMATS });
	const staticVideo = (await staticInput.getVideoTracks())[0]!;
	expect(await staticVideo.getUnixTimeForTimestamp(0)).toBe(null);

	const dynamicMpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic"
	availabilityStartTime="2026-01-01T00:00:00Z"
	minimumUpdatePeriod="PT5S" publishTime="2026-01-01T00:00:05Z">
	<Period id="p0">
		<AdaptationSet id="1" contentType="video" mimeType="video/mp4" codecs="avc1.42c01e">
			<SegmentTemplate media="v-$Number$.m4s" timescale="90000" duration="180000" startNumber="1">
				<SegmentTimeline><S t="0" d="180000" r="2"/></SegmentTimeline>
			</SegmentTemplate>
			<Representation id="v1" bandwidth="1000000" width="640" height="360"/>
		</AdaptationSet>
	</Period>
</MPD>`;
	const dynamicInput = new Input({ source: mpdSource(dynamicMpd), formats: DASH_FORMATS });
	const dynamicVideo = (await dynamicInput.getVideoTracks())[0]!;
	// Wall-clock segments are shifted into Unix space, so the first segment's
	// timestamp IS availabilityStartTime, and its Unix time equals itself.
	const availabilityStart = Date.parse('2026-01-01T00:00:00Z') / 1000;
	expect(await dynamicVideo.getUnixTimeForTimestamp(availabilityStart)).toBe(availabilityStart);
});
