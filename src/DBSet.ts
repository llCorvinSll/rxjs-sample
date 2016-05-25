import * as Rx from "rxjs/Rx";
import * as _ from "underscore";

export interface CursorParams<T> {
    size: number;
    left_buf: number;
    right_buf: number;

    load_data: (from: number, to: number) => JQueryPromise<T[]>
}


export interface CursorItem<T> {
    index: number;
    item: T;
    loaded?: boolean;
}

/**
 * Cursor
 */
export default class DBSet<T> {
    constructor(options: CursorParams<T>) {
        this.params = options;
        this.current_values = new Rx.BehaviorSubject<CursorItem<T>[]>([]);
        this.index = new Rx.BehaviorSubject<number>(0);
        this.remote_ranges_stream = new Rx.Subject<number[]>();

        this.setupRanges();

        let cached = this.range_stream.map((x: number[]) => {
            return _.map(_.range(x[0], x[1]), (x: number) => {
                if (this.cache[x] && this.cache[x].loaded) {
                    return this.cache[x];
                }

                return {
                    index: x,
                    item: null,
                    loaded: false
                };
            });
        });

        let remotes = new Rx.BehaviorSubject<CursorItem<T>[]>([]);
        remotes.combineLatest(
            cached,
            this.range_stream,
            (remote, cache, range) => {
                console.log(range, remote, cache);

                return _
                    .map(cache, (c) => {
                        let finded = _.find(remote, { index: c.index });

                        return finded ? finded : c;
                    });
            })
            .subscribe((x) => {
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
                        let res = `${val}`;
                        this.cache[val] = {
                            index: val,
                            item: res,
                            loaded: true
                        };
                        return this.cache[val];
                    })
                );
            });
    }

    public index: Rx.BehaviorSubject<number>;
    
    protected setupRanges():void {
        this.chunk_stream = this.index
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
    }

    private cache: { [key: number]: CursorItem<T> } = [];

    private chunk_stream;
    private range_stream;



    public current_values: Rx.BehaviorSubject<CursorItem<T>[]>;

    private remote_ranges_stream: Rx.Subject<number[]>;

    private params: CursorParams<T>;
}