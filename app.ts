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


interface CursorItem {
  index: number;
  item: string;
}

/**
 * Cursor
 */
class Cursor {
  constructor(options: CursorParams) {
    this.params = options;

    this.index_stream = new Rx.Subject<number>();
    this.remote_ranges_stream = new Rx.Subject<number[]>();
    this.current_values = new Rx.Subject<string[]>();

    this.index_subs = this.index_stream
      .filter((x) => x >= 0)
      .subscribe((x) => {
        this.current_index = x;
      });

    this.chunk_stream = this.index_stream
      .filter((x) => x >= 0)
      .map((x) => {
        return (Math.floor(x / (this.params.size)));
      });
      
    this.range_stream = this.chunk_stream.map((x) => {
      let left_side = this.params.size * x - this.params.left_buf;
      let right_side = this.params.size * (x + 1) + this.params.right_buf;

      return [left_side >= 0 ? left_side : 0, right_side];
    });


    this.range_stream.map((x: number[]) => {
      return _.chain<number>(_.range(x[0], x[1])).filter((index: number) => {
        return _.isUndefined(this.cache[index]);
      }).sortBy(a => a).compact().value();
    })
    .filter(x => x.length)
      .subscribe((x) => {
        this.remote_ranges_stream.next(x);
      });


    let cached = this.range_stream.map((x: number[]) => {
      
      console.log(x)
      return _.map(_.range(x[0], x[1]) ,(x) => {
        if(this.cache[x]) {
          return `cached: ${this.cache[x]}`;
        }
        
        return undefined;
      });
    });
    
    let remotes = new Rx.Subject<string[]>();
    
    this.remote_ranges_stream.map((x: number[]) => {
      return this.params.load_data(x[0], x[x.length - 1]);
    })
      .map((promise: JQueryPromise<number[]>) => {
        return Rx.Observable.fromPromise(promise);
      }).subscribe((x) => {
        x.subscribe((x) => {
          remotes.next(      
            _.map(x, (val) => {
              let res = `remote ${val}`
              this.cache[val] = res;
               return res
              })
          );
        }});
        
        
            Rx.Observable.combineLatest(
      cached,
      remotes,
      (cache, remote) => {        
       return _.map( cache, (c, i) => remote[i]? remote[i] : cache[i]); 
      }).subscribe((x) => this.current_values.next(x))
        
        
        
        this.current_values.subscribe((x) => {
          console.log(`current: ${x}`);
        })
  }

  public setIndex(new_index: number) {
    this.index_stream.next(new_index);
  }

  public getIndex(): number {
    return this.current_index;
  }

  private cache: string[] = [];

  private chunk_stream;
  private range_stream;

  private current_index: number;
  private index_subs: Rx.Subscription;
  private index_stream: Rx.Subject<number>;

  public current_values: Rx.Subject<string[]>;

  private remote_ranges_stream: Rx.Subject<number[]>;

  private params: CursorParams;
}


var cursor = new Cursor({
  size: 2,
  left_buf: 3,
  right_buf: 2,
  load_data: (from: number, to: number) => {
    let $deferred = $.Deferred<number[]>(); 
    
    setTimeout(() => { $deferred.resolve(_.range(from, to)); }, 500);
    
    return $deferred.promise();
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
  });

var right_sub = right_obs.subscribe(
  (x) => {
    cursor.setIndex(cursor.getIndex() + 1);
  });