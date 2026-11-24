package pool

import "testing"

// Fixed thresholds used across the table so each case only needs to vary what it's actually
// testing. Mirrors the defaults proposed for JUDGE_POOL_SCALE_UP_THRESHOLD_MS /
// JUDGE_POOL_SCALE_DOWN_THRESHOLD_MS.
const (
	testUpThresholdMs   = 150.0
	testDownThresholdMs = 20.0
)

func TestDecideScale(t *testing.T) {
	cases := []struct {
		name string

		min, max, target int
		avgWaitMs        float64
		hadTraffic       bool
		timeouts         int64
		upCooldown       bool
		downCooldown     bool
		headroom         bool

		wantTarget int
		wantAction string
	}{
		{
			name: "no traffic this interval holds regardless of stale wait number",
			min:  2, max: 8, target: 4,
			avgWaitMs: 999, hadTraffic: false, timeouts: 0,
			upCooldown: true, downCooldown: true, headroom: true,
			wantTarget: 4, wantAction: scaleActionHold,
		},
		{
			name: "high wait scales up when room, cooldown clear, and headroom available",
			min:  2, max: 8, target: 4,
			avgWaitMs: 300, hadTraffic: true, timeouts: 0,
			upCooldown: true, downCooldown: true, headroom: true,
			wantTarget: 5, wantAction: scaleActionUp,
		},
		{
			name: "at max holds even under heavy load",
			min:  2, max: 8, target: 8,
			avgWaitMs: 300, hadTraffic: true, timeouts: 0,
			upCooldown: true, downCooldown: true, headroom: true,
			wantTarget: 8, wantAction: scaleActionHold,
		},
		{
			name: "at min holds even when idle enough to want to shrink further",
			min:  2, max: 8, target: 2,
			avgWaitMs: 1, hadTraffic: true, timeouts: 0,
			upCooldown: true, downCooldown: true, headroom: true,
			wantTarget: 2, wantAction: scaleActionHold,
		},
		{
			name: "dead band between thresholds holds",
			min:  2, max: 8, target: 4,
			avgWaitMs: 80, hadTraffic: true, timeouts: 0,
			upCooldown: true, downCooldown: true, headroom: true,
			wantTarget: 4, wantAction: scaleActionHold,
		},
		{
			name: "low wait scales down when above min and cooldown clear",
			min:  2, max: 8, target: 4,
			avgWaitMs: 5, hadTraffic: true, timeouts: 0,
			upCooldown: true, downCooldown: true, headroom: true,
			wantTarget: 3, wantAction: scaleActionDown,
		},
		{
			name: "up-cooldown blocks an otherwise-valid scale-up",
			min:  2, max: 8, target: 4,
			avgWaitMs: 300, hadTraffic: true, timeouts: 0,
			upCooldown: false, downCooldown: true, headroom: true,
			wantTarget: 4, wantAction: scaleActionHold,
		},
		{
			name: "down-cooldown blocks an otherwise-valid scale-down",
			min:  2, max: 8, target: 4,
			avgWaitMs: 5, hadTraffic: true, timeouts: 0,
			upCooldown: true, downCooldown: false, headroom: true,
			wantTarget: 4, wantAction: scaleActionHold,
		},
		{
			name: "a single timeout forces scale-up even with avgWaitMs under the up threshold",
			min:  2, max: 8, target: 4,
			avgWaitMs: 50, hadTraffic: true, timeouts: 1,
			upCooldown: true, downCooldown: true, headroom: true,
			wantTarget: 5, wantAction: scaleActionUp,
		},
		{
			name: "timeout still can't push past max",
			min:  2, max: 8, target: 8,
			avgWaitMs: 50, hadTraffic: true, timeouts: 3,
			upCooldown: true, downCooldown: true, headroom: true,
			wantTarget: 8, wantAction: scaleActionHold,
		},
		{
			name: "no global headroom blocks scale-up even though this language wants it",
			min:  2, max: 8, target: 4,
			avgWaitMs: 300, hadTraffic: true, timeouts: 0,
			upCooldown: true, downCooldown: true, headroom: false,
			wantTarget: 4, wantAction: scaleActionHold,
		},
		{
			name: "an out-of-range target is clamped into [min,max] before deciding",
			min:  2, max: 8, target: 99,
			avgWaitMs: 1, hadTraffic: true, timeouts: 0,
			upCooldown: true, downCooldown: true, headroom: true,
			wantTarget: 7, wantAction: scaleActionDown,
		},
		{
			name: "min equals max means every decision holds",
			min:  4, max: 4, target: 4,
			avgWaitMs: 500, hadTraffic: true, timeouts: 5,
			upCooldown: true, downCooldown: true, headroom: true,
			wantTarget: 4, wantAction: scaleActionHold,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := decideScale(
				tc.min, tc.max, tc.target,
				tc.avgWaitMs, tc.hadTraffic, tc.timeouts,
				testUpThresholdMs, testDownThresholdMs,
				tc.upCooldown, tc.downCooldown,
				tc.headroom,
			)
			if got.NewTarget != tc.wantTarget || got.Action != tc.wantAction {
				t.Errorf("decideScale() = {NewTarget:%d Action:%q}, want {NewTarget:%d Action:%q}",
					got.NewTarget, got.Action, tc.wantTarget, tc.wantAction)
			}
			if got.NewTarget < tc.min || got.NewTarget > tc.max {
				t.Errorf("decideScale() returned NewTarget=%d outside bounds [%d,%d]", got.NewTarget, tc.min, tc.max)
			}
		})
	}
}
