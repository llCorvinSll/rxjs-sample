import * as Rx from "rxjs/Rx";
import * as _ from "underscore";


interface CursorParamsBase {
    size: number;
    min_reserve: number;
    max_reserve: number;

    cyclic: boolean;
}

export interface CursorParams<T> extends CursorParamsBase {
    load_data: (from: number, to: number) => JQueryPromise<T[]>;
}

export enum ItemState {
    LOADING = 0,
    LOADED,
    CACHED,
    FAIL,
}

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
        this.remote_ranges_stream = new Rx.Subject<Range>();
        this.remote_chunks = new Rx.BehaviorSubject<CursorItem<T>[]>([]);

        this.setupState();
        this.setupRanges();

        let cached = this
            .range_stream
            .map((x: Range) => {
                let range = _.range(x.begin, x.end);

                return _
                    .chain(range)
                    .map((x: number) => {
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
                    })
                    .compact()
                    .value();
        });


        let uniq_chunks = this
            .remote_ranges_stream
            .distinctUntilChanged(DBSet.rangesComparator);


        uniq_chunks
            .map((x: Range) => this.startRemoteLoading(x))
            .flatMap((value: RemoteRequest<T>) => {
                let newPromise: any = value.promise.then((resolved: T[]) => {
                    let res: _.Dictionary<{index:number; item: T}> = {};

                    if (resolved.length < DBSet.getRangeLength(value.indexes)) {

                        console.error("asdadasdasdasd", DBSet.getRangeLength(value.indexes), resolved.length);

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

        this
            .current_state
            .subscribe((x) => console.error(x));
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

    protected setupRanges():void {
        this.chunk_stream = this
            .current_state
            .map(DBSet.recalculateIndex)
            .distinctUntilChanged()
            .map((x: CursorState) => Math.floor(x.real_index / (this.params.size)));

        this.range_stream = this
            .chunk_stream
            .map((x) => {
                let chunk_len = DBSet.calculateChunkLength(this.params);
                let left_side = chunk_len * x;
                let right_side = chunk_len * (x + 1);

                return {
                    begin: left_side,
                    end: right_side,
                };
        });

        this.range_stream
            .distinctUntilChanged()
            .map((x: Range) => {
                return _
                    .chain<number>(_.range(x.begin, x.end))
                    .filter((index: number) =>_.isUndefined(this.cache[index]))
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

    private startRemoteLoading(x: Range): RemoteRequest<T> {
        return {
            promise: this.params.load_data(x.begin, x.end),
            indexes: _.range(x.begin, x.end + 1)
        };
    }

    private isFullLoaded(): boolean {
        return this.current_state.getValue().full_loaded;
    }

    private static getRangeLength(indexes: number[]): number {
        return indexes[indexes.length - 1] - indexes[0] + 1;
    }

    private static rangesComparator(a: Range, b: Range) {
        return a.begin === b.begin && a.end === b.end;
    }

    private static calculateChunkLength(params: CursorParamsBase): number {
        return params.size + (params.max_reserve * 2);
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

    private chunk_stream: Rx.Observable<number>;

    private range_stream: Rx.Observable<Range>;

    private remote_chunks: Rx.BehaviorSubject<CursorItem<T>[]>; // = new ([]);

    private remote_ranges_stream: Rx.Subject<Range>;

    private params: CursorParams<T>;
}
