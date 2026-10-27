// A release must complete one intentional downward pull. Clicks and canceled
// gestures do not spend a demo entry; other pointers cannot hijack the pull.
export function createLeverGesture() {
  let pointer = null;
  let origin = 0;
  let distance = 1;
  let progress = 0;
  return {
    get active() { return pointer !== null; },
    get progress() { return progress; },
    begin(id, y, travel) {
      if (pointer !== null || !Number.isFinite(y) || !Number.isFinite(travel) || travel <= 0) return false;
      pointer = id; origin = y; distance = travel; progress = 0;
      return true;
    },
    move(id, y) {
      if (pointer === id && Number.isFinite(y)) progress = Math.min(1, Math.max(0, (y - origin) / distance));
      return progress;
    },
    release(id) {
      if (pointer !== id) return false;
      const commit = progress >= 0.85;
      pointer = null; progress = 0;
      return commit;
    },
    cancel(id) {
      if (id === undefined || pointer === id) { pointer = null; progress = 0; }
    },
  };
}
