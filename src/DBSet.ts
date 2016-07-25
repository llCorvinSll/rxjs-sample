import * as Rx from "rxjs/Rx";
import * as _ from "underscore";

export interface CursorParams<T> {
    size: number;
    left_buf: number;
    right_buf: number;

    load_data: (from: number, to: number) => JQueryPromise<T[]>
}

export enum ItemState {
    LOADING = 0,
    LOADED,
    CACHED,
    FAIL,
};

export interface CursorItem<T> {
    index: number;
    item: T;
    state: ItemState;

}

/**
 * Cursor
 */
export default class DBSet<T> {
    constructor(options: CursorParams<T>) {
        this.params = options;
        this.current_values = new Rx.BehaviorSubject<CursorItem<T>[]>([]);

        this.remote_ranges_stream = new Rx.Subject<number[]>();
        this.remote_chunks = new Rx.BehaviorSubject<CursorItem<T>[]>([]);

        this.setupIndexes();
        this.setupRanges();

        let cached = this
            .range_stream
            .map((x: number[]) => {
                return _.compact(_.map(_.range(x[0], x[1]), (x: number) => {
                    if (this.cache[x]) {
                        this.cache[x].state = ItemState.CACHED;
                        return this.cache[x];
                    }

                    if (!this.full_loaded) {
                        return {
                            index: x,
                            item: null,
                            state: ItemState.LOADING
                        };
                    }
                }));
        });

        this.remote_chunks
            .combineLatest(
            cached.distinctUntilChanged(),
            (remote, cache) => {
                let zipped_set = _
                    .map(cache as _.Dictionary<CursorItem<T>>, (c) => {
                        let finded = _.find(remote, { index: c.index });

                        return finded ? finded : c;
                    });

                if (this.full_loaded) {
                    zipped_set = _.filter(zipped_set, (item: CursorItem<T>) => item.state !== ItemState.LOADING);
                }

                return zipped_set;
            })
            .subscribe((x) => {
                this.current_values.next(x);
            });

        this.remote_ranges_stream
            .distinctUntilChanged(DBSet.rangesComparator)
            .map((x: number[]) => this.startRemoteLoading(x))
            .flatMap((value) => {
                let newPromise: any = value.promise.then((resolved: T[]) => {
                    let res: _.Dictionary<{index:number; item: T}> = {};

                    console.error(value.range);

                    if (resolved.length < DBSet.getRangeLength(value.range)) {
                        console.error("finish", resolved.length, DBSet.getRangeLength(value.range));

                        this.total = value.range[0] + resolved.length;
                        this.full_loaded = true;
                    }

                    _.each(resolved, (val, i) => {
                        res[value.range[i]] = {
                            index: value.range[i],
                            item: val,
                        }
                    });

                    return res;
                });

                return Rx.Observable.fromPromise(newPromise);
            })
            .subscribe((x) => {
                this.remote_chunks.next(
                    _.map(x as _.Dictionary<CursorItem<T>>, (item) => {
                        this.cache[item.index] = {
                            index: item.index,
                            item: item.item,
                            state: ItemState.LOADED
                        };
                        return this.cache[item.index];
                    })
                );
            });
    }

    public getIndex(): number {
        return this.real_index.getValue();
    }

    public index: Rx.BehaviorSubject<number>;

    private real_index: Rx.BehaviorSubject<number>;


    protected setupIndexes() {
        this.index = new Rx.BehaviorSubject<number>(0);
        this.real_index = new Rx.BehaviorSubject<number>(0);

        this.index.subscribe((x: number) => {
            if (!this.full_loaded) {
                this.real_index.next(x)

                return;
            }

            if (x > this.total) {
                this.real_index.next(this.total);
                return;
            }

            this.real_index.next(x);
        });
    }

    
    protected setupRanges():void {
        this.chunk_stream = this.real_index
            .filter((x) => this.filterIndex(x))
            .map((x) => {
                return (Math.floor(x / (this.params.size)));
            });

        this.range_stream = this.chunk_stream
            .map((x) => {
            let chunk_len = this.params.size;

            let left_side = chunk_len * x - this.params.left_buf;
            let right_side = chunk_len * (x + 1) + this.params.right_buf;

            return [left_side >= 0 ? left_side : 0, right_side];
        });

        this.range_stream
            .distinctUntilChanged()
            .map((x: number[]) => {
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
                if (this.full_loaded) {
                    return;
                }

                this.remote_ranges_stream.next([x[0], x[x.length - 1]]);
            });
    }

    protected startRemoteLoading(x: number[]): {promise: JQueryPromise<T[]>; range: number[]} {
        return {
            promise: this.params.load_data(x[0], x[x.length - 1]),
            range: _.range(x[0], x[1])
        };
    }

    protected filterIndex(index: number): boolean {
        if (!this.full_loaded) {
            return index >= 0;
        }


        return index < this.total;
    }

    private static getRangeLength(indexes: number[]): number {
        return indexes[indexes.length - 1] - indexes[0] + 1;
    }

    private static rangesComparator(a:number[], b:number[]) {
        return a[0] === b[0] && a[1] === b[1];
    }

    public current_values: Rx.BehaviorSubject<CursorItem<T>[]>;

    private cache: { [key: number]: CursorItem<T> } = [];

    private chunk_stream;
    private range_stream;
    private remote_chunks:Rx.BehaviorSubject<CursorItem<T>[]>;

    private full_loaded: boolean = false;
    private total: number = null;

    private remote_ranges_stream: Rx.Subject<number[]>;

    private params: CursorParams<T>;
}
