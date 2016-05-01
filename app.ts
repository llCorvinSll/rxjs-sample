/// <reference path="typings/main/ambient/jquery/index.d.ts" />

import * as Rx from "rxjs/Rx"
import * as $ from "jquery"
import * as _ from "underscore"

interface CursorParams {
  size: number;
  left_buf: number;
  right_buf: number;

  load_data: (from: number, to: number) => JQueryPromise<number[]>

}

/**
 * Cursor
 */
class Cursor {
  constructor(options: CursorParams) {
    this.params = options;

    this.index_stream = new Rx.Subject<number>();
    this.remote_ranges_stream = new Rx.Subject<number[]>();

    //просто подписка с логгером
    this.index_subs = this.index_stream
      .filter((x) => x >= 0)
      .subscribe((x) => {
        this.current_index = x;
      });

    this.chunk_stream = this.index_stream
      .filter((x) => x >= 0)
      .map((x) => {
        return (Math.floor(x / (this.params.size)));
      })
      .map((chunk_number: number) => {
        return chunk_number;
      });

    this.range_stream = this.chunk_stream.map((x) => {
      let left_side = this.params.size * x - this.params.left_buf;
      let right_side = this.params.size * (x + 1) + this.params.right_buf;

      return [left_side >= 0 ? left_side : 0, right_side];
    });

    let missing_range = this.range_stream.map((x: number[]) => {
      return _.chain<number>(_.range(x[0], x[1])).filter((index: number) => {
        return _.isUndefined(this.cache[index]);
      }).sortBy(a => a).value();
    })
      .subscribe((x) => {
        this.remote_ranges_stream.next(x);
      });
      
      this.remote_ranges_stream.map( (x: number[]) => {
        return this.params.load_data(x[0], x[x.length - 1]);
      })
      .map((promise: JQueryPromise<number[]>) => {
        promise.then((results) => {
          console.log(results);
          return results;
        });
      }).subscribe((x) => console.log(x));
  }

  public setIndex(new_index: number) {
    this.index_stream.next(new_index);
  }

  public getIndex(): number {
    return this.current_index;
  }

  private cache: number[] = [];

  private chunk_stream;
  private range_stream;

  private current_index: number;
  private index_subs: Rx.Subscription;
  private index_stream: Rx.Subject<number>;

  private remote_ranges_stream: Rx.Subject<number[]>;

  private params: CursorParams;
}


var cursor = new Cursor({
  size: 2,
  left_buf: 3,
  right_buf: 2,
  load_data: (from: number, to: number) => { 
    console.log(from, to);
    return $.Deferred<number[]>().resolve(_.range(from, to+1)).promise(); 
  }
});
cursor.setIndex(0);

var $left_btn = $("#left-btn")
var $right_btn = $("#right-btn")

var left_obs = Rx.Observable.fromEvent($left_btn, "click");
var right_obs = Rx.Observable.fromEvent($right_btn, "click");

var left_sub = left_obs.subscribe(
  (x) => {
    cursor.setIndex(cursor.getIndex() - 1);
  },
  function (err) {
    console.log('Error: %s', err);
  },
  function () {
    console.log('Completed');
  });

var right_sub = right_obs.subscribe(
  (x) => {
    cursor.setIndex(cursor.getIndex() + 1);
  },
  function (err) {
    console.log('Error: %s', err);
  },
  function () {
    console.log('Completed');
  });