package pool

import "testing"

// JUDGE_FIX_PLAN T4: one language can only tie up claimsPerContainer bulk workers per container.

func TestTryClaimCapsWorkersPerLanguage(t *testing.T) {
	p := poolWithIdle("cpp", 2, 2)
	p.limits["python"] = LangLimits{Min: 1, Max: 2}
	p.targets["python"] = 2

	var releases []func()
	for i := 0; i < 4; i++ { // 2 containers x 2 workers each
		release, ok := p.TryClaim("cpp")
		if !ok {
			t.Fatalf("claim %d refused before the limit", i+1)
		}
		releases = append(releases, release)
	}
	if _, ok := p.TryClaim("cpp"); ok {
		t.Fatal("a fifth cpp worker was admitted with only 2 containers")
	}
	if _, ok := p.TryClaim("python"); !ok {
		t.Fatal("a cpp burst blocked python")
	}

	releases[0]()
	releases[0]() // giving a claim back twice must not free two slots
	if _, ok := p.TryClaim("cpp"); !ok {
		t.Fatal("a released claim was not reusable")
	}
	if _, ok := p.TryClaim("cpp"); ok {
		t.Fatal("a double release freed two slots")
	}
}

func TestTryClaimFollowsTheScalingTarget(t *testing.T) {
	p := poolWithIdle("java", 1, 8)
	p.targets["java"] = 1
	for i := 0; i < 2; i++ {
		if _, ok := p.TryClaim("java"); !ok {
			t.Fatalf("claim %d refused", i+1)
		}
	}
	if _, ok := p.TryClaim("java"); ok {
		t.Fatal("admitted past 2 workers for 1 container")
	}
	p.targets["java"] = 3 // the autoscaler grew the pool
	if _, ok := p.TryClaim("java"); !ok {
		t.Fatal("a larger target did not admit more workers")
	}
}

func TestTryClaimAdmitsUnknownLanguages(t *testing.T) {
	p := poolWithIdle("go", 1, 1)
	for i := 0; i < 10; i++ {
		if _, ok := p.TryClaim("cobol"); !ok {
			t.Fatal("a language the pool does not serve should fall through to the acquire")
		}
	}
}
