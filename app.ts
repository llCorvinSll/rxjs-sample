import * as Rx from "rxjs/Rx";
import * as $ from "jquery";
import * as _ from "underscore";
import {CursorItem, default as DBSet} from "./src/DBSet";


var cursor = new DBSet<string>({
    size: 5,
    left_buf: 5,
    right_buf: 5,
    load_data: (frm: number, to: number) => {
        let $deferred = $.Deferred<string[]>();

        setTimeout(() => { $deferred.resolve(_.range(frm, to).map((e) => e.toString())); }, 1000);

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
        cursor.index.next(cursor.index.getValue() - 1);
    });

var right_sub = right_obs.subscribe(
    (x) => {
        cursor.index.next(cursor.index.getValue() + 1);
    });


let $cont = $("#out");

cursor.current_values.subscribe((x:CursorItem<string>[]) => {
    $cont.empty();

    $cont.append(`<h1> ${cursor.index.getValue()} </h1>`)

    _.each(x, (val) => {
        let selected = val.index.toString() == cursor.index.getValue();

        $cont.append(`<p> ${val.index} - ${val.item} : loaded ${val.loaded} ${selected ? "+++" : ""} </p>`)
    });

});