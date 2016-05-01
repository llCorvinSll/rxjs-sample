import * as Rx from "rxjs/RX"


var source = new Rx.Observable<number>((observer:Rx.Observer<number>) => {
  // Yield a single value and complete
  observer.next(42);
  observer.complete();

  // Any cleanup logic might go here
  return () => console.log('disposed')
});

var subscription = source.subscribe(
  x => console.log('onNext: %s', x),
  e => console.log('onError: %s', e),
  () => console.log('onCompleted'));

// => onNext: 42
// => onCompleted

subscription.unsubscribe();