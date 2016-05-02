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
    loaded?: boolean;
}

/**
 * Cursor
 */
class Cursor {
    constructor(options: CursorParams) {
        this.params = options;

        this.index_stream = new Rx.Subject<number>();
        this.remote_ranges_stream = new Rx.Subject<number[]>();
        this.current_values = new Rx.BehaviorSubject<string[]>([]);

        this.index_stream
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
            let chunk_len = this.params.size;

            let left_side = chunk_len * x - this.params.left_buf;
            let right_side = chunk_len * (x + 1) + this.params.right_buf;

            return [left_side >= 0 ? left_side : 0, right_side];
        });

        this.range_stream.map((x: number[]) => {
            return _
                .chain<number>(_.range(x[0], x[1] + 1))
                .filter((index: number) => {
                    return _.isUndefined(this.cache[index]);
                })
                .uniq()
                .sortBy(a => a)
                .value();
        })
            .filter(x => x.length > 1)
            .subscribe((x) => {
                this.remote_ranges_stream.next([x[0], x[x.length - 1] + this.params.right_buf]);
            });

        let cached = this.range_stream.map((x: number[]) => {
            return _.map<number>(_.range(x[0], x[1]), (x: number) => {
                if (this.cache[x] && this.cache[x].loaded) {
                    return this.cache[x];
                }

                return { index: x, item: "", loaded: false };
            });
        });

        let remotes = new Rx.BehaviorSubject<string[]>([]);
        remotes.combineLatest(
            cached,
            (remote, cache) => {
                return _
                    .map(cache, (c, i) => {
                        let finded = _.find(remote, { index: c.index });

                        return finded ? finded : c;
                    });
            }).subscribe((x) => {
                this.current_values.next(x);
            });

        this.remote_ranges_stream.map((x: number[]) => {
            return {
                promise: this.params.load_data(x[0], x[x.length - 1]),
                range: x
            }
        })
            .flatMap((value) => {
                let newPromise = value.promise.then((values) => {
                    let range = _.range(value.range[0], value.range[1]);

                    let res = {};

                    return _.each(values, (val, i) => {
                        res[range[i]] = {
                            index: range[i],
                            item: `item ${val}`,
                        }

                    })
                });

                return Rx.Observable.fromPromise(newPromise);
            })
            .subscribe((x) => {
                remotes.next(
                    _.map(x, (val) => {
                        let res = `remote ${val}`
                        this.cache[val] = { index: val, item: res, loaded: true };
                        return this.cache[val];
                    })
                );
            });
    }

    public setIndex(new_index: number) {
        this.index_stream.next(new_index);
    }

    public getIndex(): number {
        return this.current_index;
    }

    private cache: { [key: number]: CursorItem } = [];

    private chunk_stream;
    private range_stream;

    private current_index: number;
    private index_stream: Rx.Subject<number>;

    public current_values: Rx.BehaviorSubject<string[]>;

    private remote_ranges_stream: Rx.Subject<number[]>;

    private params: CursorParams;
}


var cursor = new Cursor({
    size: 5,
    left_buf: 5,
    right_buf: 5,
    load_data: (frm: number, to: number) => {
        let $deferred = $.Deferred<number[]>();

        setTimeout(() => { $deferred.resolve(_.range(frm, to)); }, 2000);

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



let $cont = $("#out");

cursor.current_values.subscribe((x) => {
    $cont.empty();

    _.each(x, (val) => {
        let selected = val.index === cursor.getIndex();

        $cont.append(`<p> ${val.index} - ${val.item} : loaded ${val.loaded} ${selected ? "+++" : ""} </p>`)
    });

})