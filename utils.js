export function createObservableMap() {
  const map = new Map();
  const listeners = {
    add: [],
    remove: []
  };

  const handler = {
    get(target, prop, receiver) {
      // Special handling for 'set' to trigger listeners
      if (prop === 'set') {
        return function(key, value) {
          const isNewKey = !target.has(key);
          target.set(key, value);
          if (isNewKey) {
            listeners.add.forEach(callback => callback(key, value));
          }
          return receiver; // Allow method chaining
        };
      }

      // Special handling for 'delete' to trigger listeners
      if (prop === 'delete') {
        return function(key) {
          const hasKey = target.has(key);
          const result = target.delete(key);
          if (hasKey && result) {
            listeners.remove.forEach(callback => callback(key));
          }
          return result;
        };
      }

      // Special handling for 'clear' to trigger listeners
      if (prop === 'clear') {
        return function() {
          const keys = Array.from(target.keys());
          target.clear();
          keys.forEach(key => listeners.remove.forEach(callback => callback(key)));
        };
      }

      // Handle 'onAdd' and 'onRemove'
      if (prop === 'onAdd') {
        return function(callback) {
          listeners.add.push(callback);
        };
      }

      if (prop === 'onRemove') {
        return function(callback) {
          listeners.remove.push(callback);
        };
      }

      // Handle all other properties and methods
      const value = target[prop];
      if (typeof value === 'function') {
        return value.bind(target);
      }
      return value;
    }
  };

  return new Proxy(map, handler);
}

// Usage example
const observableMap = createObservableMap();

observableMap.onAdd((key, value) => {
  console.log(`New item added: ${key} => ${value}`);
});

observableMap.onRemove((key) => {
  console.log(`Item deleted: ${key}`);
});

observableMap.set('foo', 'bar'); // Console: New item added: foo => bar
console.log(observableMap.get('foo')); // Console: bar
observableMap.set('baz', 'qux'); // Console: New item added: baz => qux
observableMap.set('foo', 'new value'); // No console log since 'foo' is not a new key
console.log(observableMap.get('baz')); // Console: qux
observableMap.delete('foo'); // Console: Item deleted: foo
observableMap.clear(); // Console: Item deleted: baz
console.log(observableMap.has('foo')); // Console: false
