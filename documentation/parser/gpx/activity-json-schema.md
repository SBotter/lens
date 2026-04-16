# GPX Parser — Activity JSON Schema

This document explains every field produced by the GPX parser.
The output is the contract between the **Parser** layer and the **Engine** layer.

---

## Top-level structure

```json
{
  "activity": {
    "metadata": { ... },
    "summary":  { ... },
    "timeline": [ ... ],
    "laps":     [ ... ],
    "quality":  { ... }
  }
}
```

---

## `metadata`

Who, what, and when. Describes the activity at the identity level.

| Field | Type | Example | Description |
|-------|------|---------|-------------|
| `source` | string | `"gpx"` | File format the data was parsed from. Always `"gpx"` for this parser. Future values: `"fit"`, `"tcx"`. |
| `vendor` | string | `"garmin"` | Company that produced the file. Detected from the XML `creator` attribute and namespace declarations. Possible values: `garmin`, `strava`, `suunto`, `wahoo`, `polar`, `coros`, `apple`, `unknown`. |
| `device` | string | `"Garmin Connect"` | App or device name as detected from the file header. For Garmin GPX exports, this is always `"Garmin Connect"` (the app that generated the file, not the physical watch model). |
| `activityName` | string | `"Mount Fromme - Classic Loop"` | Name the athlete gave the activity, taken from `<trk><name>`. |
| `activityType` | string | `"mountain_biking"` | Activity sport type from `<trk><type>`. Normalized to lowercase with underscores. Strava numeric types (e.g. `"1"`) are translated to text (e.g. `"cycling"`). |
| `startTime` | number | `1774713434000` | Unix timestamp in **milliseconds** (UTC) of the first recorded GPS point. |
| `endTime` | number | `1774720817000` | Unix timestamp in **milliseconds** (UTC) of the last recorded GPS point. |
| `totalTime` | number | `7383` | Elapsed wall-clock time in **seconds** from first to last point. Includes stops. Formula: `(endTime - startTime) / 1000`. |
| `movingTime` | number | `6554` | Time in **seconds** spent actually moving (speed ≥ 0.3 m/s). Excludes stops. Formula: `totalTime - totalStopTime`. |

---

## `summary`

Aggregated statistics for the entire activity. Computed from the full timeline.

| Field | Type | Example | Description |
|-------|------|---------|-------------|
| `totalDistance` | number | `16937.39` | Total distance traveled in **meters**. Sum of haversine distances between consecutive GPS points. |
| `elevationGain` | number | `30.4` | Total positive elevation change in **meters**. Only counts upward changes ≥ 0.5 m (noise filter). Cumulative sum of all climbs. |
| `elevationLoss` | number | `439.8` | Total negative elevation change in **meters** (absolute value). Only counts downward changes ≥ 0.5 m. For a descent-heavy MTB activity, this will be much larger than `elevationGain`. |
| `avgSpeed` | number | `2.5843` | Average speed in **m/s** while moving. Formula: `totalDistance / movingTime`. Excludes time spent stopped. Multiply by `3.6` to convert to km/h. |
| `maxSpeed` | number | `11.0882` | Peak speed recorded in **m/s** across all timeline points. Computed from haversine distance / time delta between consecutive points. |
| `avgHeartRate` | number \| null | `149` | Average heart rate in **bpm** across all points that have HR data. `null` if the file contains no heart rate data (e.g. GPS-only export). |
| `maxHeartRate` | number \| null | `173` | Peak heart rate in **bpm** recorded during the activity. `null` if no HR data. |
| `avgCadence` | number \| null | `null` | Average cadence in **rpm** (rotations per minute). `null` if the GPS device did not record cadence (e.g. no cadence sensor paired). Common for cycling/running with a sensor, rare in GPX exports. |
| `avgPower` | number \| null | `null` | Average power output in **watts**. `null` if no power meter was connected. More common in FIT exports than GPX. |
| `stops` | number | `21` | Count of distinct stop events. A stop is defined as: speed drops below 0.3 m/s **and** stays there for at least 5 seconds. Each time the athlete resumes movement after a qualifying stop = one stop event. |
| `totalStopTime` | number | `829` | Total time in **seconds** spent stopped (speed < 0.3 m/s). Formula: `totalTime - movingTime`. |

---

## `timeline`

The heart of the output. One entry per GPS point recorded by the device. For a 1-second GPS recording over 2 hours, this is ~7,200 entries.

Each point contains everything the Engine needs to make decisions about that moment.

### `timeline[n].t`

```json
"t": 5
```

**Relative time in seconds from the start of the activity.**

This is the most important field for video synchronization. It answers: *"At what second of the recording did this happen?"*

- `t: 0` = first GPS point = activity start
- `t: 3600` = exactly 1 hour in
- Always a whole number (rounded)
- Makes timeline alignment trivial: `video_frame_at = videoStartOffset + t`

---

### `timeline[n].timestamp`

```json
"timestamp": 1774713434000
```

**Absolute UTC time in milliseconds (Unix epoch).**

The real-world clock time of this point. Used to synchronize the activity timeline with video files that have their own UTC timestamps. While `t` is relative, `timestamp` is absolute — needed to match GPS data against a video recorded at a known UTC time.

---

### `timeline[n].position`

```json
"position": { "lat": 49.3394, "lon": -123.0327 }
```

**Geographic coordinates** (WGS84 datum, decimal degrees).

- `lat`: Latitude. Positive = North, negative = South. Range: -90 to +90.
- `lon`: Longitude. Positive = East, negative = West. Range: -180 to +180.

Rounded to 4 decimal places (~11 meters of precision). The raw GPS file stores up to 10 decimal places but 4 is sufficient for mapping and sync purposes.

---

### `timeline[n].elevation`

```json
"elevation": 141.4
```

**Altitude above sea level in meters** (GPS barometric or satellite, depending on device).

Rounded to 2 decimal places. Used to compute `movement.grade`, `movement.verticalSpeed`, and the `derived.isClimbing` / `derived.isDescending` flags.

---

### `timeline[n].movement`

The physical description of what the body/bike/vehicle was doing at this second.

```json
"movement": {
  "distance": 1.96,
  "speed": 1.9557,
  "acceleration": 1.9557,
  "verticalSpeed": 0.4,
  "grade": 0.2045
}
```

| Field | Unit | Description |
|-------|------|-------------|
| `distance` | meters | Distance traveled from the **previous** point. Computed via haversine formula. `0` for the first point. |
| `speed` | m/s | Instantaneous speed at this point. Formula: `distance / dt` where `dt` is the time gap in seconds. For Apple Health exports, the device-reported speed is used instead (more accurate at short intervals). Multiply by `3.6` for km/h. |
| `acceleration` | m/s² | Rate of speed change from previous point. Formula: `(speed - prevSpeed) / dt`. Positive = speeding up, negative = braking. |
| `verticalSpeed` | m/s | Rate of elevation change. Formula: `(elevation - prevElevation) / dt`. Positive = climbing, negative = descending. |
| `grade` | fraction | Slope steepness. Formula: `(elevation delta) / (horizontal distance)`. `0.05` = 5% grade. Positive = uphill, negative = downhill. `0` when stationary or moving horizontally. |

---

### `timeline[n].direction`

Where the athlete is heading and how sharply they are turning.

```json
"direction": {
  "heading": 46.18,
  "turnAngle": -5.88
}
```

| Field | Unit | Description |
|-------|------|-------------|
| `heading` | degrees (0–360) | Compass bearing toward the **next** GPS point. `0` = North, `90` = East, `180` = South, `270` = West. Computed from GPS coordinates using the haversine bearing formula. Uses look-ahead (current → next point) for smooth direction. |
| `turnAngle` | degrees (−180 to +180) | Change in heading from the previous point. Positive = turning right, negative = turning left. `0` = going straight. A value of `−90` means a sharp left turn. |

---

### `timeline[n].biometrics`

Sensor data recorded by the athlete's wearable at this exact second.
Fields are **absent** (not `null`) when the sensor was not active for that point.

```json
"biometrics": {
  "heartRate": 100,
  "temperature": 18
}
```

| Field | Unit | Source | Description |
|-------|------|--------|-------------|
| `heartRate` | bpm | HR strap or wrist sensor | Heart rate in beats per minute at this instant. Present when the device had a connected HR sensor. |
| `cadence` | rpm | Cadence sensor | Pedal/stride cadence. For cycling: pedal revolutions per minute. For running: steps per minute (usually halved). Absent if no cadence sensor. |
| `power` | watts | Power meter | Instantaneous power output. Cycling: from crank/pedal/hub power meter. Running: estimated by some devices. Absent without a power meter. |
| `temperature` | °C | Ambient sensor | Air temperature in Celsius. Recorded by devices with temperature sensors (Garmin Fenix, Edge). Note: may read higher than actual air temp when device is in direct sun or on wrist. |

---

### `timeline[n].derived`

**Computed boolean states.** These are the "brain" of the timeline — the Engine uses these to make storytelling and highlight decisions without needing to re-analyze the data.

```json
"derived": {
  "isMoving": true,
  "isStop": false,
  "isClimbing": true,
  "isDescending": false,
  "isSprinting": false,
  "isHighEffort": false
}
```

| Field | Description | How it is computed |
|-------|-------------|-------------------|
| `isMoving` | Athlete is moving (not stopped). | `speed ≥ 0.3 m/s` |
| `isStop` | Athlete is stopped. | `!isMoving` — always the inverse of `isMoving` |
| `isClimbing` | Moving uphill. | `isMoving AND (verticalSpeed > 0.05 m/s OR grade > 2%)` |
| `isDescending` | Moving downhill. | `isMoving AND (verticalSpeed < -0.05 m/s OR grade < -2%)` |
| `isSprinting` | Moving significantly above average pace. | `speed ≥ max(avgMovingSpeed × 1.5, 4 m/s)`. Threshold adapts to the activity — a sprint on MTB is different from a sprint on a run. |
| `isHighEffort` | Heart rate is in the high-intensity zone. | `heartRate ≥ 85% of max observed HR in this session`. Requires HR data — always `false` if no HR sensor. |

**These flags are where the Engine's highlight detection begins.** A sequence of consecutive `isSprinting: true` points = sprint segment. Consecutive `isClimbing: true` points = climb segment. The Engine scans these to find moments worth showing.

---

### `timeline[n].quality`

GPS signal reliability and sensor availability at this exact point.
Used by the Engine to decide whether to trust or skip a segment.

```json
"quality": {
  "gpsSignalQuality": 0.9862,
  "hasHeartRate": true,
  "hasCadence": false,
  "hasPower": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `gpsSignalQuality` | 0.0–1.0 | GPS reliability score for this point. `1.0` = perfect. Computed by comparing the instantaneous speed against a smoothed 8-point moving average. Large deviations from the trend = GPS jitter = lower score. For Apple Health files, uses the device-reported horizontal accuracy (`hAcc`) directly. Stationary points always score `1.0`. |
| `hasHeartRate` | boolean | Whether this specific point has HR data. Allows the Engine to handle partial HR recording (e.g. sensor dropped mid-activity). |
| `hasCadence` | boolean | Whether cadence data is present at this point. |
| `hasPower` | boolean | Whether power data is present at this point. |

---

## `laps`

Auto-detected movement segments. A new lap begins every time the athlete resumes movement after a qualifying stop (≥ 5 seconds stationary).

For an MTB activity with 21 stops, this produces 22 laps — each representing one continuous riding segment between pauses.

```json
{
  "index": 0,
  "startTime": 1774713434000,
  "endTime":   1774718065000,
  "distance":  9578.13,
  "duration":  4631,
  "avgSpeed":  2.0683,
  "avgHeartRate": 160,
  "elevationGain": 29.2
}
```

| Field | Unit | Description |
|-------|------|-------------|
| `index` | integer | Zero-based lap number in chronological order. |
| `startTime` | ms | Unix timestamp of first point in this lap. |
| `endTime` | ms | Unix timestamp of last point in this lap. |
| `distance` | meters | Total distance covered in this lap. |
| `duration` | seconds | Elapsed time for this lap (`endTime - startTime`). |
| `avgSpeed` | m/s | Average speed during this lap (`distance / duration`). |
| `avgHeartRate` | bpm \| null | Average HR across all points in this lap with HR data. `null` if no HR. |
| `elevationGain` | meters | Cumulative upward elevation within this lap (noise-filtered ≥ 0.5 m). |

---

## `quality`

Overall data quality assessment for the entire activity. Used by the Engine for fallback decisions and processing confidence.

```json
"quality": {
  "overallScore": 0.9014,
  "gpsQuality": {
    "signalConsistency": 0.8995,
    "noiseLevel": 0.2358,
    "gaps": 0
  },
  "dataCompleteness": {
    "heartRate": 1,
    "cadence": 0,
    "power": 0
  }
}
```

### `quality.overallScore`

**0.0–1.0 composite score.** Weighted formula:

```
overallScore =
  0.40 × signalConsistency     // GPS signal quality while moving
  0.20 × (1 - noiseLevel)      // GPS cleanliness
  0.20 × gap penalty           // Penalizes dropout events
  0.10 × heartRate completeness
  0.10 × (1 - stop fraction)   // More moving time = higher score
```

`0.90` = excellent data. `< 0.60` = degraded — Engine should apply fallback logic.

### `quality.gpsQuality`

| Field | Description |
|-------|-------------|
| `signalConsistency` | Mean GPS quality score across all moving points. `1.0` = perfectly smooth track. Low values indicate GPS multipath interference (e.g. dense forest, urban canyons). |
| `noiseLevel` | Fraction of points with `gpsSignalQuality < 0.85`. `0.0` = no noise. `1.0` = every point is noisy. |
| `gaps` | Count of time gaps greater than 10 seconds between consecutive points. `0` = continuous recording. Each gap means the GPS dropped out (tunnel, device pause, low battery). |

### `quality.dataCompleteness`

Fraction of timeline points that have each sensor reading.

| Field | Example | Meaning |
|-------|---------|---------|
| `heartRate` | `1.0` | 100% of points have HR data — sensor was active the entire activity. |
| `cadence` | `0.0` | No cadence data at all — sensor not connected. |
| `power` | `0.0` | No power data — power meter not connected. |
| `heartRate: 0.72` | (hypothetical) | HR sensor dropped 28% of the way through — battery died or strap lost contact. |

---

## Units reference

| Unit | Symbol | Used for |
|------|--------|----------|
| Unix milliseconds | ms | `startTime`, `endTime`, `timestamp` |
| Seconds | s | `t`, `totalTime`, `movingTime`, `duration`, `totalStopTime` |
| Meters | m | `totalDistance`, `distance`, `elevationGain`, `elevationLoss` |
| Meters per second | m/s | `speed`, `avgSpeed`, `maxSpeed`, `verticalSpeed`, `acceleration` prefix |
| Meters per second² | m/s² | `acceleration` |
| Degrees (compass) | ° | `heading`, `turnAngle` |
| Fraction | — | `grade` (0.05 = 5%), quality scores (0–1) |
| BPM | bpm | `heartRate`, `avgHeartRate`, `maxHeartRate` |
| RPM | rpm | `cadence`, `avgCadence` |
| Watts | W | `power`, `avgPower` |
| Celsius | °C | `temperature` |
| Decimal degrees | ° | `lat`, `lon` |

---

## Converting common values

```
speed m/s → km/h      multiply by 3.6
speed m/s → mph       multiply by 2.237
grade fraction → %    multiply by 100
distance m → km       divide by 1000
Unix ms → Date        new Date(timestamp)
```

---

## Engine contract

The Engine receives this JSON and can assume:
- `timeline` is sorted chronologically by `t` (ascending)
- `t` starts at `0` and increments by the GPS recording interval (usually 1 second)
- All timestamps are UTC milliseconds
- All speeds are in m/s
- `derived` flags are pre-computed and trusted — the Engine does not need to re-derive them
- `null` values in `summary` mean the sensor was not present — the Engine handles gracefully
- Missing keys in `biometrics` mean no data for that sensor at that point
- `quality.overallScore < 0.60` should trigger fallback processing mode
