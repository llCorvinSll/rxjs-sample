import * as Rx from "rxjs/Rx";
import * as _ from "underscore";

export interface CursorParams<T> {
    size: number;
    max_reserv: number;
    right_buf: number;

    cyclic: boolean;
    capacity: number;

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
    cyclic: boolean;
}

interface Range {
    begin: number;
    end: number;
}

interface RemoteRequest<T> {
    promise: JQueryPromise<T[]>;
    indexes: number[];
}

/**
 * Cursor
 */
export default class DBSet<T> {
    constructor(options: CursorParams<T>) {
        this.params = options;
        this.current_values = new Rx.BehaviorSubject<CursorItem<T>[]>([]);
        this.remote_chunks = new Rx.BehaviorSubject<CursorItem<T>[]>([]);

        this.setupState();
        this.setupRanges();

        let cached = this.getCachedStream();
        this.forwardLoading();
        this.backwardLoading();

        this.remote_chunks
            .combineLatest(
                cached.distinctUntilChanged(),
                (remote, cache) => {
                    let zipped_set = _
                        .map(cache, (c) => {
                            let finded = _.find(remote, {index: c.index});

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

        this.setIndex(0);
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
            total: 0,
            cyclic: this.params.cyclic
        });
    }


    protected getCachedStream(): Rx.Observable<CursorItem<T>[]> {
        return this
            .range_stream
            .map((x: Range) => {
                let final = [];

                console.error("RANGE", x);

                let normalized_ranges = DBSet.splitRangeToNormals(x);
                let forward_range = normalized_ranges.length === 1 ? normalized_ranges[0] : normalized_ranges[1];
                let backward_range = normalized_ranges.length === 2 ? normalized_ranges[0] : null;

                if (forward_range) {
                    let forward_indexes = _.range(forward_range.begin, forward_range.end + 1);
                    let forward_expected_len = DBSet.getRangeLength(forward_indexes);


                    if (this.isFullLoaded()) {
                        forward_indexes = _.filter(forward_indexes, (x: number) => {
                            return !!this.cache[x];
                        });


                        if (this.current_state.getValue().cyclic) {
                            let delta = forward_expected_len - DBSet.getRangeLength(forward_indexes);

                            if (delta > 0) {
                                for (let i = 0; i <= delta; i++) {
                                    forward_indexes.push(i);
                                }
                            }
                        }
                    }

                    final = final.concat(forward_indexes);
                }

                if (backward_range && this.params.cyclic && (this.params.capacity || this.isFullLoaded())) {
                    console.error("Backward range", backward_range);

                    backward_range = DBSet.convertInvertedRangeToNormal(backward_range, this.params.capacity + 1);

                    console.error("Backward range normalized", backward_range);

                    let backward_indexes = _.range(backward_range.begin, backward_range.end + 1);
                    let backward_expected_len = DBSet.getRangeLength(backward_indexes);


                    console.error("Tail", backward_indexes);


                    final = backward_indexes.reverse().concat(final);
                }

                return _
                    .chain(final)
                    .filter((x: number) => x >= 0)
                    .map((x: number) => {
                        if (this.cache[x]) {
                            this.cache[x].state = ItemState.CACHED;
                            return this.cache[x];
                        }

                        return {
                            index: x,
                            item: null,
                            state: ItemState.LOADING
                        };
                    })
                    .compact()
                    .value();
            });
    }

    protected forwardLoading() {
        //forward loading
        this.remote_ranges_stream
            .filter(x => !DBSet.isRangeInverted(x))
            .distinctUntilChanged(DBSet.rangesComparator)
            .map((x: Range) => this.startRemoteLoading(x))
            .flatMap((value: RemoteRequest<T>) => {
                let newPromise: any = value.promise.then((resolved: T[]) => {
                    let res: _.Dictionary<{index: number; item: T}> = {};

                    if (resolved.length < DBSet.getRangeLength(value.indexes)) {
                        let state = this.current_state.getValue();

                        this.current_state.next(_.extend({}, state, {
                            total: value.indexes[0] + resolved.length,
                            full_loaded: true,
                        }));
                    }

                    _.each(resolved, (val, i) => {
                        res[value.indexes[i]] = {
                            index: value.indexes[i],
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

    protected backwardLoading() {
        //если в параметрах такого нет - просто не запускаем процедуру
        if (!this.params.cyclic || !this.params.capacity) {
            return;
        }

        let backward_range = new Rx.Subject<Range>();
        backward_range
            .map((x: Range) => {
                return DBSet.convertInvertedRangeToNormal(x, this.params.capacity);
            })
            .map((x) => this.startRemoteLoading(x))
            .flatMap((value: RemoteRequest<T>) => {
                console.error("Backward", value.indexes);
                let newPromise: any = value.promise.then((resolved: T[]) => {
                    let res: _.Dictionary<{index: number; item: T}> = {};

                    _.each(resolved, (val, i) => {
                        res[value.indexes[i]] = {
                            index: value.indexes[i],
                            item: val,
                        }
                    });

                    return [res, value.indexes];
                });

                return Rx.Observable.fromPromise(newPromise);
            })
            .subscribe((x: any[]) => {
                let result = x[0] as _.Dictionary<CursorItem<T>>;

                if (_.isEmpty(result)) {
                    this.params.capacity -= x[1].length;

                    backward_range.next({
                        begin: -3,
                        end: -1
                    });

                    return;
                }

                let max_index = 0;
                _.each(result, (item: CursorItem<T>) => {
                    if (item.index > max_index) {
                        max_index = item.index;
                    }

                    this.cache[item.index] = item;
                });

                this.params.capacity = max_index;

                let state = this.current_state.getValue();

                this.current_state.next(_.extend({}, state, {
                    total: this.params.capacity + 1,
                }));
            });

        //backward loading
        this.remote_ranges_stream
            .takeUntil(backward_range)
            .filter((x: Range) => DBSet.isRangeInverted(x))
            .distinctUntilChanged(DBSet.rangesComparator)
            .filter(() => !!this.params.cyclic && !!this.params.capacity)
            .subscribe((x) => {
                console.error(x);
                backward_range.next(x);
            });
    }

    protected setupRanges():void {
        this.range_stream = this
            .current_state
            .map(DBSet.recalculateIndex)
            .distinctUntilChanged()
            .map((x: CursorState) => {
                //TODO: нормально подправлять индекс
                return (Math.floor(x.real_index / (this.params.size)));
            })
            .map((x) => {
                let chunk_len = this.params.size;
                let left_side = chunk_len * x - this.params.max_reserv;

                if (!this.current_state.getValue().cyclic) {
                    left_side = left_side >= 0 ? left_side : 0;
                }

                let right_side = chunk_len * (x + 1) + this.params.max_reserv - 1;

                return {
                    begin: left_side,
                    end: right_side,
                };
        });

        this.remote_ranges_stream = this.range_stream
            .distinctUntilChanged()
            .map((x: Range) => DBSet.splitRangeToNormals(x))
            .flatMap((x: Range[]) => {
                return Rx.Observable.from(x);
            })
            .map((x: Range) => {
            return _
                .chain<number>(_.range(x.begin, x.end + 1))
                .filter((index: number) =>_.isUndefined(this.cache[index]))
                .uniq()
                .sortBy(a => a)
                .value();
            })
            .filter(x => x.length > 1)
            .map((x: number[]) => {
                let res = {
                    begin: x[0],
                    end: x[x.length - 1]
                };
                return res;
            })
            .filter(x => {
                if (this.isFullLoaded()) {
                    return x.begin >= 0;
                }

                return true;
            });
    }

    protected startRemoteLoading(x: Range): RemoteRequest<T> {
        return {
            promise: this.params.load_data(x.begin, x.end),
            indexes: _.range(x.begin, x.end + 1)
        };
    }

    protected isFullLoaded(): boolean {
        return this.current_state.getValue().full_loaded;
    }

    private static getRangeLength(indexes: number[]): number {
        return indexes.length;

        return indexes[indexes.length - 1] - indexes[0] + 1;
    }

    private static splitRangeToNormals(range: Range): Range[] {
        if (range.begin >= 0) {
            return [range];
        }

        let result = [];

        result.push({
            begin: range.begin,
            end: -1
        });

        result.push({
            begin: 0,
            end: range.end
        });

        return result;
    }

    private static rangesComparator(a: Range, b: Range) {
        return a.begin === b.begin && a.end === b.end;
    }

    private static isRangeInverted(x: Range): boolean {
        return x.begin < 0;
    }

    private static convertInvertedRangeToNormal(x: Range, total: number): Range {
        return {
            begin: total + x.begin,
            end: total + x.end
        };
    }

    private static recalculateIndex(state: CursorState): CursorState {
        let new_state = state;

        if (state.cyclic && state.full_loaded) {
            //Сделано для того, чтобы при любых value новое значение было в диапазоне [0, total)
            //Если сделать (total + value) % total, то при value < 0 и |value| > total будет неправильное значение
            if (state.index < 0) {
                new_state.real_index = (state.total + state.index % state.total) % state.total;
            } else {
                new_state.real_index = state.index % state.total;
            }
        } else {
            new_state.real_index = Math.max(state.index, 0);
            if (state.total) {
                new_state.real_index = Math.min(state.index, state.total ? state.total - 1 : 0);
            }
        }

        return new_state;
    }

    public current_values: Rx.BehaviorSubject<CursorItem<T>[]>;

    private current_state: Rx.BehaviorSubject<CursorState>;

    private cache: { [key: number]: CursorItem<T> } = [];

    private range_stream: Rx.Observable<Range>;

    private remote_chunks: Rx.BehaviorSubject<CursorItem<T>[]>;

    private remote_ranges_stream: Rx.Observable<Range>;

    private params: CursorParams<T>;
}
