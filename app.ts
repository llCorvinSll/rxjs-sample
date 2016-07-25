import * as Rx from "rxjs/Rx";
import * as $ from "jquery";
import * as _ from "underscore";
import {CursorItem, default as DBSet, ItemState} from "./src/DBSet";

var MAX_SIZE = 15;

var cursor = new DBSet<string>({
    size: 3,
    left_buf: 3,
    right_buf: 3,
    load_data: (frm: number, to: number) => {
        let $deferred = $.Deferred<string[]>();

        if (to > MAX_SIZE) {
            to = MAX_SIZE;
        }

        setTimeout(() => {
            $deferred.resolve(_.range(frm, to).map((e) => `remote ${e}`));
        }, 1000);

        return $deferred.promise();
    }
});
cursor.index.next(0);

var $left_btn = $("#left-btn")
var $right_btn = $("#right-btn")

var left_obs = Rx.Observable.fromEvent($left_btn, "click");
var right_obs = Rx.Observable.fromEvent($right_btn, "click");

var left_sub = left_obs.subscribe(
    (x) => {
        cursor.index.next(cursor.getIndex() - 1);
    });

var right_sub = right_obs.subscribe(
    (x) => {
        cursor.index.next(cursor.getIndex() + 1);
    });


let $cont = $("#out");

cursor.current_values.subscribe((x:CursorItem<string>[]) => {
    $cont.empty();

    $cont.append(`<h1> ${cursor.getIndex()} </h1>`)

    _.each(x, (val) => {
        let selected = val.index === cursor.getIndex();

        $cont.append(`<p> ${val.index} - ${val.item} : state ${ItemState[val.state]} ${selected ? "+++" : ""} </p>`)
    });
});
