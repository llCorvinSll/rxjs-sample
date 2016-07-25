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


interface CursorState {
    index: number;
    real_index: number;
    full_loaded: boolean;
    total: number;
}

interface Range {
    begin: number;
    end: number;
}

/**
 * Cursor
 */
export default class DBSet<T> {
    constructor(options: CursorParams<T>) {
        this.params = options;
        this.current_values = new Rx.BehaviorSubject<CursorItem<T>[]>([]);
        this.remote_ranges_stream = new Rx.Subject<Range>();

        this.remote_chunks = new Rx.BehaviorSubject<CursorItem<T>[]>([]);

        this.setupState();
        this.setupRanges();

        let cached = this
            .range_stream
            .map((x: Range) => {
                return _.compact(_.map(_.range(x.begin, x.end), (x: number) => {
                    if (this.cache[x]) {
                        this.cache[x].state = ItemState.CACHED;
                        return this.cache[x];
                    }

                    if (!this.isFullLoaded()) {
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

                if (this.isFullLoaded()) {
                    zipped_set = _.filter(zipped_set, (item: CursorItem<T>) => item.state !== ItemState.LOADING);
                }

                return zipped_set;
            })
            .subscribe((x) => {
                this.current_values.next(x);
            });

        this.remote_ranges_stream
            .distinctUntilChanged(DBSet.rangesComparator)
            .map((x: Range) => this.startRemoteLoading(x))
            .flatMap((value) => {
                let newPromise: any = value.promise.then((resolved: T[]) => {
                    let res: _.Dictionary<{index:number; item: T}> = {};

                    if (resolved.length < DBSet.getRangeLength(value.range)) {
                        console.error("finish", resolved.length, DBSet.getRangeLength(value.range));

                        let state = this.current_state.getValue();

                        this.current_state.next(_.extend({}, state, {
                            total: value.range[0] + resolved.length,
                            full_loaded: true,
                        }));
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

    public setIndex(index: number): void {
        let value = this.current_state.getValue();

        this.current_state.next(_.extend({}, value, {
            index: index
        }));
    }

    public getIndex(): number {
        return this.current_state.getValue().real_index;
    }

    protected setupState(): void {
        this.current_state = new Rx.BehaviorSubject<CursorState>({
            index: 0,
            real_index: 0,
            full_loaded: false,
            total: 0
        });
    }

    protected setupRanges():void {
        this.chunk_stream = this
            .current_state
            .map(DBSet.recalculateIndex)
            .distinctUntilChanged()
            .map((x: CursorState) => {
                return (Math.floor(x.real_index / (this.params.size)));
            });

        this.range_stream = this
            .chunk_stream
            .map((x) => {
                let chunk_len = this.params.size;
                let left_side = chunk_len * x - this.params.left_buf;
                let right_side = chunk_len * (x + 1) + this.params.right_buf;

                return {
                    begin: left_side >= 0 ? left_side : 0,
                    end: right_side,
                };
        });

        this.range_stream
            .distinctUntilChanged()
            .map((x: Range) => {
            return _
                .chain<number>(_.range(x.begin, x.end))
                .filter((index: number) => {
                    return _.isUndefined(this.cache[index]);
                })
                .uniq()
                .sortBy(a => a)
                .value();
            })
            .filter(x => x.length > 1)
            .subscribe((x: number[]) => {
                if (this.current_state.getValue().full_loaded) {
                    return;
                }

                this.remote_ranges_stream.next({
                    begin: x[0],
                    end: x[x.length - 1]
                });
            });
    }

    protected startRemoteLoading(x: Range): {promise: JQueryPromise<T[]>; range: number[]} {
        return {
            promise: this.params.load_data(x.begin, x.end),
            range: _.range(x.begin, x.end)
        };
    }

    protected isFullLoaded(): boolean {
        return this.current_state.getValue().full_loaded;
    }

    private static getRangeLength(indexes: number[]): number {
        return indexes[indexes.length - 1] - indexes[0] + 1;
    }

    private static rangesComparator(a: Range, b: Range) {
        return a.begin === b.begin && a.end === b.end;
    }

    protected static recalculateIndex(state: CursorState): CursorState {
        let new_state = state;

        if (!state.full_loaded) {
            new_state.real_index = new_state.index;

            return new_state;
        }

        if (state.index >= state.total) {
            new_state.real_index = state.total - 1;
            return new_state;
        }

        new_state.real_index = state.index;

        return new_state;
    }

    public current_values: Rx.BehaviorSubject<CursorItem<T>[]>;

    private current_state: Rx.BehaviorSubject<CursorState>;

    private cache: { [key: number]: CursorItem<T> } = [];

    private chunk_stream: Rx.Observable<number>;

    private range_stream: Rx.Observable<Range>;

    private remote_chunks; //:Rx.BehaviorSubject<CursorItem<T>[]>;

    private remote_ranges_stream: Rx.Subject<Range>;

    private params: CursorParams<T>;
}
