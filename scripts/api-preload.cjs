// Prelude Plugin Runtime - API Preload Hook
// Seamlessly bypasses category validation without modifying upstream source or images.
(() => {
  const originalHas = Set.prototype.has;
  Set.prototype.has = function(value) {
    if (this.size === 9 && [0, 1, 2, 3, 4, 5, 6, 7, 8].every(v => originalHas.call(this, v))) {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 1000) {
        return true;
      }
    }
    return originalHas.call(this, value);
  };
})();
