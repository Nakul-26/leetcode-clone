package pool

import "testing"

func TestOwnedByThisInstance(t *testing.T) {
	t.Setenv("JUDGE_INSTANCE", "examportal-go-judge")
	cases := []struct {
		labels map[string]string
		want   bool
	}{
		{map[string]string{"managed-by": "judge-service", InstanceLabelKey: "examportal-go-judge"}, true},
		{map[string]string{"managed-by": "judge-service", InstanceLabelKey: "examportal-exam-sandbox"}, false},
		{map[string]string{"managed-by": "judge-service"}, true}, // from a judge before the label
	}
	for _, c := range cases {
		if got := OwnedByThisInstance(c.labels); got != c.want {
			t.Errorf("OwnedByThisInstance(%v) = %v, want %v", c.labels, got, c.want)
		}
	}
}
