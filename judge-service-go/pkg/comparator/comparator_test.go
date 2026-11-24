package comparator

import (
	"testing"

	"judge-service-go/pkg/models"
)

func TestCompare_NumberNormalization(t *testing.T) {
	cfg := models.CompareConfig{}
	if !Compare(int64(3), float64(3), cfg) {
		t.Fatalf("expected int64(3) and float64(3) to be equal")
	}
}

func TestCompare_FloatTolerance(t *testing.T) {
	cfg := models.CompareConfig{FloatTolerance: 1e-3}
	if !Compare(1.0004, 1.0009, cfg) {
		t.Fatalf("expected values to be equal within tolerance")
	}
	if Compare(1.0, 1.01, cfg) {
		t.Fatalf("expected values to be different outside tolerance")
	}
}

func TestCompare_DeepNested(t *testing.T) {
	cfg := models.CompareConfig{}
	expected := map[string]interface{}{
		"nums": []interface{}{float64(1), float64(2)},
		"meta": map[string]interface{}{"ok": true},
	}
	actual := map[string]interface{}{
		"nums": []interface{}{int64(1), int(2)},
		"meta": map[string]interface{}{"ok": true},
	}
	if !Compare(expected, actual, cfg) {
		t.Fatalf("expected nested structures to match")
	}
}

func TestCompare_OrderInsensitiveSlices(t *testing.T) {
	cfg := models.CompareConfig{OrderInsensitive: true}
	expected := []interface{}{1, 2, 3}
	actual := []interface{}{3, 1, 2}
	if !Compare(expected, actual, cfg) {
		t.Fatalf("expected slices to match ignoring order")
	}
}

func TestCompare_NilAndEmptySlice(t *testing.T) {
	cfg := models.CompareConfig{}

	if !Compare(nil, []interface{}{}, cfg) {
		t.Fatalf("expected nil and empty slice to match")
	}

	if !Compare([]interface{}{}, nil, cfg) {
		t.Fatalf("expected empty slice and nil to match")
	}

	// Test nested
	expected := map[string]interface{}{"data": []interface{}{}}
	actual := map[string]interface{}{"data": nil}
	if !Compare(expected, actual, cfg) {
		t.Fatalf("expected nested nil and empty slice to match")
	}
}
