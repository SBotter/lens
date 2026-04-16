/**
 * Shared activity physics pipeline — used by GPX, FIT, and TCX parsers.
 *
 * All parsers convert their source data to RawPoint[] then call
 * computePhysics() → assemble() to produce canonical ActivityJSON output.
 * Changes to physics, smoothing, or derived flags apply to every format.
 */

import type {
  ActivityFormat, ActivityVendor, ActivityJSON, TimelinePoint, LapData,
  ActivitySegment,
} from '../../types';

export const PARSER_VERSION = '1.1.0';

// ── Constants ─────────────────────────────────────────────────────────────────

/** m/s below which a point is considered stationary (~1 km/h). */
export const STOP_SPEED_MS   = 0.3;
/** Minimum stop duration to count as a stop event. */
export const MIN_STOP_S      = 5;
/** GPS time gap (seconds) that signals a dropout. */
export const GAP_THRESHOLD_S = 10;

// ── Raw point — common input for all parsers ──────────────────────────────────

export interface RawPoint {
  lat:              number;
  lon:              number;
  ele:              number;
  time:             number;   // Unix ms UTC
  hr?:              number;   // bpm
  cad?:             number;   // rpm
  pwr?:             number;   // watts
  temp?:            number;   // °C
  speed?:           number;   // m/s — device-native speed (preferred over haversine)
  nativeDistance?:  number;   // m  — device delta distance (FIT cumulative diff)
  hacc?:            number;   // m  — horizontal accuracy (Apple Health)
}

// ── Physics point — after motion computation ──────────────────────────────────

export interface PhysicsPoint {
  raw:          RawPoint;
  dt:           number;       // seconds since previous point
  distance:     number;       // meters (haversine or nativeDistance)
  speed:        number;       // m/s
  acceleration: number;       // m/s²
  vertSpeed:    number;       // m/s
  grade:        number;       // fraction
  heading:      number;       // degrees 0–360
  turn:         number;       // degrees −180 to +180
}

export interface StopEvent { startMs: number; endMs: number; durationS: number }

// ── Math helpers ──────────────────────────────────────────────────────────────

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R  = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a  = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const y  = Math.sin(Δλ) * Math.cos(φ2);
  const x  = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function shortestAngle(a: number, b: number): number {
  let d = b - a;
  while (d >  180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

export function mean(vals: number[]): number {
  if (vals.length === 0) return 0;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

export function r2(n: number): number { return Math.round(n * 100) / 100; }
export function r4(n: number): number { return Math.round(n * 10000) / 10000; }

export function numOrUndef(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return isFinite(n) ? n : undefined;
}

// ── Smoothing ─────────────────────────────────────────────────────────────────

export function movingAverage(values: number[], half: number): number[] {
  return values.map((_, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length - 1, i + half);
    let sum = 0, n = 0;
    for (let j = lo; j <= hi; j++) { sum += values[j]; n++; }
    return n > 0 ? sum / n : 0;
  });
}

/**
 * Smooth elevation values before computing gain/loss.
 *
 * Window targets ~30 seconds of data regardless of recording frequency:
 *   1 s/pt → half=15 (±15 points = 30 s)
 *  60 s/pt → half=2  (±2 points  = ±2 min — avoids over-smoothing sparse data)
 */
export function smoothedElevations(pts: PhysicsPoint[], avgIntervalS = 1): number[] {
  const half = Math.max(2, Math.min(15, Math.round(30 / Math.max(1, avgIntervalS))));
  return movingAverage(pts.map(p => p.raw.ele), half);
}

export function accumulateElevation(smoothed: number[]): { gain: number; loss: number } {
  let gain = 0, loss = 0;
  for (let i = 1; i < smoothed.length; i++) {
    const d = smoothed[i] - smoothed[i - 1];
    if (d > 0) gain += d;
    else       loss += Math.abs(d);
  }
  return { gain, loss };
}

// ── Physics pipeline ──────────────────────────────────────────────────────────

export function computePhysics(raw: RawPoint[]): PhysicsPoint[] {
  const result: PhysicsPoint[] = [];

  for (let i = 0; i < raw.length; i++) {
    const cur  = raw[i];
    const prev = i > 0 ? raw[i - 1] : null;
    const dt   = prev ? (cur.time - prev.time) / 1000 : 0;

    // Distance: prefer device-native delta (FIT), fall back to haversine
    const gpsDist  = prev && dt > 0 ? haversine(prev.lat, prev.lon, cur.lat, cur.lon) : 0;
    const distance = (cur.nativeDistance != null && cur.nativeDistance >= 0)
      ? cur.nativeDistance
      : gpsDist;

    // Speed: prefer device-native (more accurate at short intervals)
    const speed = cur.speed != null && isFinite(cur.speed)
      ? cur.speed
      : (dt > 0 ? gpsDist / dt : 0);

    const prevSpeed = i > 0 ? result[i - 1].speed : 0;
    const acc       = dt > 0 ? (speed - prevSpeed) / dt : 0;
    const dEle      = prev ? cur.ele - prev.ele : 0;
    const vertSpeed = dt > 0 ? dEle / dt : 0;
    const grade     = distance > 1.0 ? dEle / distance : 0;

    // Heading: look-ahead to next point for smooth direction
    const next    = i < raw.length - 1 ? raw[i + 1] : null;
    const hFrom   = prev ?? cur;
    const hTo     = next ?? cur;
    const heading = hFrom !== hTo
      ? bearingDeg(hFrom.lat, hFrom.lon, hTo.lat, hTo.lon)
      : (i > 0 ? result[i - 1].heading : 0);
    const prevHeading = i > 0 ? result[i - 1].heading : heading;

    result.push({
      raw: cur, dt, distance, speed, acceleration: acc,
      vertSpeed, grade, heading, turn: shortestAngle(prevHeading, heading),
    });
  }

  return result;
}

// ── GPS quality ───────────────────────────────────────────────────────────────

export function computePerPointQuality(pts: PhysicsPoint[]): number[] {
  const speeds = pts.map(p => p.speed);
  const smooth = movingAverage(speeds, 4);

  return pts.map((p, i) => {
    // Apple Health provides explicit horizontal accuracy — use it directly
    if (p.raw.hacc != null) {
      return r4(Math.max(0, 1 - p.raw.hacc * 0.01));
    }
    // Stationary points have no movement jitter to penalize
    if (p.speed < STOP_SPEED_MS) return 1.0;

    const ref = smooth[i];
    if (ref < 0.1) return 1.0;
    const deviation = Math.abs(p.speed - ref) / ref;
    return r4(Math.max(0, 1 - deviation * 0.5));
  });
}

// ── Stop detection ────────────────────────────────────────────────────────────

export function detectStops(pts: PhysicsPoint[]): StopEvent[] {
  const stops: StopEvent[] = [];
  let inStop = false;
  let stopStartMs = 0;

  for (let i = 0; i < pts.length; i++) {
    const stopped = pts[i].speed < STOP_SPEED_MS;

    if (stopped && !inStop) {
      inStop = true;
      stopStartMs = pts[i].raw.time;
    } else if (!stopped && inStop) {
      inStop = false;
      const dur = (pts[i - 1].raw.time - stopStartMs) / 1000;
      if (dur >= MIN_STOP_S)
        stops.push({ startMs: stopStartMs, endMs: pts[i - 1].raw.time, durationS: dur });
    }
  }

  if (inStop && pts.length > 0) {
    const dur = (pts[pts.length - 1].raw.time - stopStartMs) / 1000;
    if (dur >= MIN_STOP_S)
      stops.push({ startMs: stopStartMs, endMs: pts[pts.length - 1].raw.time, durationS: dur });
  }

  return stops;
}

// ── Lap builder (stop-based) ──────────────────────────────────────────────────

export function buildLaps(pts: PhysicsPoint[], stops: StopEvent[]): LapData[] {
  if (pts.length === 0) return [];

  const cuts: Array<{ ms: number; isEnd: boolean }> = stops.flatMap(s => [
    { ms: s.startMs, isEnd: false },
    { ms: s.endMs,   isEnd: true  },
  ]);
  cuts.push({ ms: pts[pts.length - 1].raw.time + 1, isEnd: false });
  cuts.sort((a, b) => a.ms - b.ms);

  const laps: LapData[] = [];
  let lapIndex = 0, segStartMs = pts[0].raw.time, ptIdx = 0;

  for (const cut of cuts) {
    if (cut.isEnd) { segStartMs = cut.ms; continue; }

    const segPts: PhysicsPoint[] = [];
    while (ptIdx < pts.length && pts[ptIdx].raw.time < cut.ms) {
      if (pts[ptIdx].raw.time >= segStartMs) segPts.push(pts[ptIdx]);
      ptIdx++;
    }

    if (segPts.length < 2) continue;

    const dist     = segPts.reduce((s, p) => s + p.distance, 0);
    const duration = (segPts[segPts.length - 1].raw.time - segPts[0].raw.time) / 1000;
    const hrVals   = segPts.map(p => p.raw.hr).filter((v): v is number => v != null);
    const segAvgInterval = segPts.length > 1
      ? (segPts[segPts.length - 1].raw.time - segPts[0].raw.time) / 1000 / (segPts.length - 1)
      : 1;
    const eleGain = accumulateElevation(smoothedElevations(segPts, segAvgInterval)).gain;

    laps.push({
      index:         lapIndex++,
      startTime:     segPts[0].raw.time,
      endTime:       segPts[segPts.length - 1].raw.time,
      distance:      r2(dist),
      duration:      Math.round(duration),
      avgSpeed:      r4(duration > 0 ? dist / duration : 0),
      avgHeartRate:  hrVals.length > 0 ? Math.round(mean(hrVals)) : null,
      elevationGain: r2(eleGain),
      source:        'computed',
    });

    segStartMs = cut.ms;
  }

  return laps;
}

// ── Segment builder ───────────────────────────────────────────────────────────

export function buildSegments(pts: PhysicsPoint[], stops: StopEvent[]): ActivitySegment[] {
  if (pts.length === 0) return [];

  const segments: ActivitySegment[] = [];
  const firstMs = pts[0].raw.time;
  const lastMs  = pts[pts.length - 1].raw.time;

  const sorted = [...stops].sort((a, b) => a.startMs - b.startMs);
  let cursor   = firstMs;

  for (const stop of sorted) {
    if (stop.startMs > cursor) {
      segments.push({
        type:      'moving',
        startMs:   cursor,
        endMs:     stop.startMs,
        durationS: Math.round((stop.startMs - cursor) / 1000),
      });
    }
    segments.push({
      type:      'stop',
      startMs:   stop.startMs,
      endMs:     stop.endMs,
      durationS: Math.round(stop.durationS),
    });
    cursor = stop.endMs;
  }

  if (cursor < lastMs) {
    segments.push({
      type:      'moving',
      startMs:   cursor,
      endMs:     lastMs,
      durationS: Math.round((lastMs - cursor) / 1000),
    });
  }

  return segments;
}

// ── Metadata helpers ──────────────────────────────────────────────────────────

export function parseTimeMetadata(timeStr: string | null): { isUTC: boolean; timezoneOffset: number } {
  if (!timeStr) return { isUTC: true, timezoneOffset: 0 };
  if (/Z$/i.test(timeStr)) return { isUTC: true, timezoneOffset: 0 };
  const m = timeStr.match(/([+-])(\d{2}):(\d{2})$/);
  if (m) {
    const offset = (m[1] === '+' ? 1 : -1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
    return { isUTC: offset === 0, timezoneOffset: offset };
  }
  return { isUTC: true, timezoneOffset: 0 };
}

export function computeSampling(pts: PhysicsPoint[]): {
  isRegular: boolean; avgInterval: number; medianInterval: number; minInterval: number; maxInterval: number;
} {
  const intervals = pts.slice(1).map(p => p.dt).filter(dt => dt > 0);
  if (intervals.length === 0)
    return { isRegular: true, avgInterval: 1, medianInterval: 1, minInterval: 1, maxInterval: 1 };
  const avg = intervals.reduce((s, v) => s + v, 0) / intervals.length;
  const sorted = [...intervals].sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const min    = sorted[0];
  const max    = sorted[sorted.length - 1];
  const variance = intervals.reduce((s, v) => s + (v - avg) ** 2, 0) / intervals.length;
  const isRegular = Math.sqrt(variance) / avg < 0.2;
  return { isRegular, avgInterval: r2(avg), medianInterval: r2(median), minInterval: r2(min), maxInterval: r2(max) };
}

export function computeBoundingBox(pts: PhysicsPoint[]): {
  minLat: number; maxLat: number; minLon: number; maxLon: number;
} {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of pts) {
    if (p.raw.lat < minLat) minLat = p.raw.lat;
    if (p.raw.lat > maxLat) maxLat = p.raw.lat;
    if (p.raw.lon < minLon) minLon = p.raw.lon;
    if (p.raw.lon > maxLon) maxLon = p.raw.lon;
  }
  return { minLat: r4(minLat), maxLat: r4(maxLat), minLon: r4(minLon), maxLon: r4(maxLon) };
}

// ── Assembly ──────────────────────────────────────────────────────────────────

export interface AssembleOpts {
  source:           ActivityFormat;
  activityName:     string;
  activityType:     string;
  vendor:           ActivityVendor;
  device:           string;
  /** 0–1 confidence in timestamp accuracy. FIT=1.0, GPX+Z=0.9, no TZ=0.5. Default: 0.8 */
  clockConfidence?: number;
  time?:            { isUTC: boolean; timezoneOffset: number };
  /** Pre-built laps (e.g. native FIT/TCX laps). If omitted, auto-detected from stops. */
  laps?:            LapData[];
}

export function assemble(pts: PhysicsPoint[], opts: AssembleOpts): ActivityJSON {
  if (pts.length === 0) throw new Error('Activity: no valid track points after parsing');

  const { source, activityName, activityType, vendor, device } = opts;
  const firstTime      = pts[0].raw.time;
  const lastTime       = pts[pts.length - 1].raw.time;
  const clockConf      = opts.clockConfidence ?? 0.8;
  const quality        = computePerPointQuality(pts);
  const stops          = detectStops(pts);
  const sampling       = computeSampling(pts);
  const laps           = opts.laps ?? buildLaps(pts, stops);
  const segments       = buildSegments(pts, stops);
  const bbox           = computeBoundingBox(pts);
  const timeMeta       = opts.time ?? { isUTC: true, timezoneOffset: 0 };
  const speedSmooth    = movingAverage(pts.map(p => p.speed), 4);

  // ── Monotonicity check ─────────────────────────────────────────────────────
  let isMonotonic = true;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].raw.time <= pts[i - 1].raw.time) { isMonotonic = false; break; }
  }

  // ── Single O(n) pass for aggregate stats ───────────────────────────────────
  let totalDistance = 0, movingTimeS = 0, totalStopTimeS = 0, maxSpeed = 0;
  let hrSum = 0, hrCount = 0, cadSum = 0, cadCount = 0, pwrSum = 0, pwrCount = 0, maxHR = 0;
  let hasTempData = false, hasNativeSpeed = false, hasNativeDist = false;

  for (const p of pts) {
    totalDistance += p.distance;
    if (p.speed > maxSpeed) maxSpeed = p.speed;
    if (p.speed >= STOP_SPEED_MS) movingTimeS    += p.dt;
    else                          totalStopTimeS += p.dt;
    if (p.raw.hr   != null) { hrSum  += p.raw.hr;  if (p.raw.hr > maxHR) maxHR = p.raw.hr; hrCount++;  }
    if (p.raw.cad  != null) { cadSum += p.raw.cad; cadCount++; }
    if (p.raw.pwr  != null) { pwrSum += p.raw.pwr; pwrCount++; }
    if (p.raw.temp != null) hasTempData    = true;
    if (p.raw.speed          != null) hasNativeSpeed = true;
    if (p.raw.nativeDistance != null) hasNativeDist  = true;
  }

  const smoothedEle = smoothedElevations(pts, sampling.avgInterval);
  const eleAccum    = accumulateElevation(smoothedEle);
  const totalTime   = (lastTime - firstTime) / 1000;

  // ── GPS quality metrics ────────────────────────────────────────────────────
  const movingQuality     = quality.filter((_, i) => pts[i].speed >= STOP_SPEED_MS);
  const signalConsistency = r4(movingQuality.length > 0 ? mean(movingQuality) : 0.9);
  const noiseLevel        = r4(quality.filter(q => q < 0.85).length / Math.max(quality.length, 1));
  let gapCount = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].dt > GAP_THRESHOLD_S) gapCount++;
  }

  const completenessHR  = hrCount  > 0 ? r4(hrCount  / pts.length) : 0;
  const completenessCad = cadCount > 0 ? r4(cadCount / pts.length) : 0;
  const completenessPwr = pwrCount > 0 ? r4(pwrCount / pts.length) : 0;

  const overallScore = r4(
    0.40 * signalConsistency +
    0.20 * (1 - noiseLevel) +
    0.20 * (gapCount === 0 ? 1 : Math.max(0, 1 - gapCount * 0.1)) +
    0.10 * completenessHR +
    0.10 * (1 - Math.min(1, totalStopTimeS / Math.max(totalTime, 1))),
  );

  // ── Normalization metadata ─────────────────────────────────────────────────
  const fieldsMapped: string[] = [];
  if (hrCount  > 0)     fieldsMapped.push('heartRate');
  if (cadCount > 0)     fieldsMapped.push('cadence');
  if (pwrCount > 0)     fieldsMapped.push('power');
  if (hasTempData)      fieldsMapped.push('temperature');
  if (hasNativeSpeed)   fieldsMapped.push('nativeSpeed');
  if (hasNativeDist)    fieldsMapped.push('nativeDistance');

  // ── Sync readiness ─────────────────────────────────────────────────────────
  const samplingConf = r4(
    signalConsistency *
    (sampling.isRegular ? 1.0 : 0.8) *
    Math.max(0, 1 - gapCount * 0.05),
  );
  const syncScore = r4(
    0.40 * clockConf +
    0.30 * samplingConf +
    0.20 * signalConsistency +
    0.10 * 1.0,  // hasLocation is always true when we have pts
  );

  // ── Timeline ───────────────────────────────────────────────────────────────
  const timeline: TimelinePoint[] = pts.map((p, i) => {
    const isMoving     = p.speed >= STOP_SPEED_MS;
    const isClimbing   = isMoving && (p.vertSpeed > 0.05 || p.grade > 0.02);
    const isDescending = isMoving && (p.vertSpeed < -0.05 || p.grade < -0.02);

    const bio: TimelinePoint['biometrics'] = {};
    if (p.raw.hr   != null) bio.heartRate   = p.raw.hr;
    if (p.raw.cad  != null) bio.cadence     = p.raw.cad;
    if (p.raw.pwr  != null) bio.power       = p.raw.pwr;
    if (p.raw.temp != null) bio.temperature = p.raw.temp;

    return {
      t:         (p.raw.time - firstTime) / 1000,
      dt:        p.dt,
      timestamp: p.raw.time,
      position:  { lat: r4(p.raw.lat), lon: r4(p.raw.lon) },
      elevation: r2(p.raw.ele),
      movement: {
        distance:      r2(p.distance),
        speed:         r4(p.speed),
        speedSmoothed: r4(speedSmooth[i]),
        speedSource:   p.raw.speed != null ? 'device' : 'computed',
        acceleration:  r4(p.acceleration),
        verticalSpeed: r4(p.vertSpeed),
        grade:         r4(p.grade),
      },
      direction: {
        heading:   r2(p.heading),
        turnAngle: r2(p.turn),
      },
      biometrics: bio,
      derived: {
        isMoving,
        isStop:       !isMoving,
        isClimbing,
        isDescending,
      },
      quality: {
        gpsSignalQuality: quality[i],
        hasHeartRate:     p.raw.hr  != null,
        hasCadence:       p.raw.cad != null,
        hasPower:         p.raw.pwr != null,
      },
    };
  });

  return {
    activity: {
      metadata: {
        source,
        vendor,
        device,
        activityName,
        activityType,
        startTime:   firstTime,
        endTime:     lastTime,
        totalTime:   Math.round(totalTime),
        movingTime:  Math.round(movingTimeS),
        boundingBox: bbox,
        sampling,
        time: {
          isUTC:           timeMeta.isUTC,
          timezoneOffset:  timeMeta.timezoneOffset,
          clockConfidence: r4(clockConf),
          isMonotonic,
        },
      },
      summary: {
        totalDistance:  r2(totalDistance),
        elevationGain:  r2(eleAccum.gain),
        elevationLoss:  r2(eleAccum.loss),
        avgSpeed:       r4(movingTimeS > 0 ? totalDistance / movingTimeS : 0),
        maxSpeed:       r4(maxSpeed),
        avgHeartRate:   hrCount  > 0 ? Math.round(hrSum  / hrCount)  : null,
        maxHeartRate:   hrCount  > 0 ? maxHR : null,
        avgCadence:     cadCount > 0 ? Math.round(cadSum / cadCount) : null,
        avgPower:       pwrCount > 0 ? Math.round(pwrSum / pwrCount) : null,
        stops:          stops.length,
        totalStopTime:  Math.round(totalStopTimeS),
      },
      normalization: {
        parserVersion: PARSER_VERSION,
        sourceFormat:  source,
        fieldsMapped,
      },
      sync: {
        hasAbsoluteTime:    timeMeta.isUTC && clockConf >= 0.7,
        hasLocation:        true,
        clockConfidence:    r4(clockConf),
        samplingConfidence: samplingConf,
        syncScore,
      },
      timeline,
      segments,
      laps,
      quality: {
        overallScore,
        gpsQuality:       { signalConsistency, noiseLevel, gaps: gapCount },
        dataCompleteness: { heartRate: completenessHR, cadence: completenessCad, power: completenessPwr },
      },
    },
  };
}
