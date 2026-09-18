frappe.provide("frappe.views");

// Minimal SVG element factory (the gantt library's own createSVG is not exported).
function svg_el(tag, attrs, parent) {
	const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
	Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
	if (parent) parent.appendChild(el);
	return el;
}

frappe.views.GanttView = class GanttView extends frappe.views.ListView {
	get view_name() {
		return "Gantt";
	}

	setup_defaults() {
		return super
			.setup_defaults()
			.then(() => {
				this.page_title = this.page_title + " " + __("Gantt");
				// A plan is read whole: the list's 20 (100 on a tall screen) rows cut a chart off
				// mid-workstream with only a Load More button below to say so (avn-main).
				this.page_length = this.selected_page_count = 500;
				this.calendar_settings = frappe.views.calendar[this.doctype] || {};

				if (typeof this.calendar_settings.gantt == "object") {
					Object.assign(this.calendar_settings, this.calendar_settings.gantt);
				}

				if (this.calendar_settings.order_by) {
					this.sort_by = this.calendar_settings.order_by;
					this.sort_order = "asc";
				} else {
					this.sort_by =
						this.view_user_settings.sort_by || this.calendar_settings.field_map.start;
					this.sort_order = this.view_user_settings.sort_order || "asc";
				}
			})
			.then(() => this.setup_dependency_config());
	}

	// Dependency editing (avn-main): which child table on this doctype holds the predecessor
	// links. Explicit: frappe.views.calendar[dt].depends_on_table =
	//   { child_doctype, parentfield, link_field }
	// Otherwise the first Table field whose child doctype carries a Link back to this doctype
	// (Task -> "Task Depends On".task). Nothing found = arrows stay read-only.
	setup_dependency_config() {
		this.dependency_config = null;
		const explicit = this.calendar_settings.depends_on_table;
		if (explicit) {
			this.dependency_config = explicit;
			return;
		}
		const table_fields = (this.meta.fields || []).filter(
			(df) => df.fieldtype === "Table" && df.options
		);
		if (!table_fields.length) return;
		return Promise.all(
			table_fields.map(
				(df) =>
					new Promise((resolve) => frappe.model.with_doctype(df.options, () => resolve(df)))
			)
		).then((dfs) => {
			for (const df of dfs) {
				const child_meta = frappe.get_meta(df.options);
				const link =
					child_meta &&
					child_meta.fields.find(
						(f) => f.fieldtype === "Link" && f.options === this.doctype
					);
				if (link) {
					this.dependency_config = {
						child_doctype: df.options,
						parentfield: df.fieldname,
						link_field: link.fieldname,
					};
					return;
				}
			}
		});
	}

	// Tree doctypes (Task: is_group + parent_task): the parent link lets the chart nest each
	// child under its group and draw the group as a summary bar (avn-main).
	async set_fields() {
		await super.set_fields();
		if (this.meta.is_tree && this.meta.nsm_parent_field) {
			this._add_field(this.meta.nsm_parent_field);
		}
	}

	get parent_field() {
		return this.meta.is_tree ? this.meta.nsm_parent_field : null;
	}

	setup_view() {}

	prepare_data(data) {
		super.prepare_data(data);
		this.prepare_tasks();
	}

	prepare_tasks() {
		var me = this;
		var meta = this.meta;
		var field_map = this.calendar_settings.field_map;
		var depends_on_field = field_map.depends_on || "depends_on_tasks";

		this.tasks = this.data.map(function (item) {
			// set progress
			var progress = 0;
			if (field_map.progress && $.isFunction(field_map.progress)) {
				progress = field_map.progress(item);
			} else if (field_map.progress) {
				progress = item[field_map.progress];
			}

			// title
			var label;
			if (meta.title_field) {
				label = item.progress
					? __("{0} ({1}) - {2}%", [item[meta.title_field], item.name, item.progress])
					: __("{0} ({1})", [item[meta.title_field], item.name]);
			} else {
				label = item[field_map.title];
			}

			var r = {
				start: item[field_map.start],
				end: item[field_map.end],
				name: label,
				id: item[field_map.id || "name"],
				doctype: me.doctype,
				progress: progress,
				dependencies: item[depends_on_field] || "",
			};

			if (item.color && frappe.ui.color.validate_hex(item.color)) {
				r["custom_class"] = "color-" + item.color.substr(1);
			}

			if (item.is_milestone) {
				r["custom_class"] = "bar-milestone";
			}

			if (me.parent_field) {
				r.is_group = !!item.is_group;
				r.parent_id = item[me.parent_field] || null;
				if (r.is_group) r.custom_class = "bar-group " + (r.custom_class || "");
			}

			return r;
		});

		if (this.parent_field) this.arrange_tree();
		this.prune_missing_dependencies();
	}

	// While a bar is dragged the library dereferences every dependency's bar
	// (Bar.update_bar_position -> gantt.get_bar(dep).$bar) to stop a task being moved before a
	// predecessor. A predecessor that is not on the chart -- filtered out by a list filter, or
	// past the loaded page -- makes that lookup undefined, so it throws on every mousemove and
	// the bar cannot be moved at all, silently. Drop those ids: a constraint the user cannot
	// see should not freeze the bar. Predecessors that ARE on the chart still constrain it.
	// Upstream frappe-gantt 0.6.1 bug.
	prune_missing_dependencies() {
		const loaded = new Set(this.tasks.map((t) => t.id));
		this.tasks.forEach((t) => {
			if (!t.dependencies) return;
			t.dependencies = t.dependencies
				.split(",")
				.map((id) => id.trim())
				.filter((id) => id && loaded.has(id))
				.join(",");
		});
	}

	// Groups as summary rows: each group is followed by its children (recursively, in the
	// list's own order), spans its children's dates, and the arrows that merely encode
	// containment are dropped. ERPNext appends every child to its parent's depends_on on
	// save, so without this a group shows an arrow from each of its children; the rows stay
	// in the data (they stop a group being completed before its children), only the chart
	// leaves them out. A child whose parent is not loaded stays where the list put it.
	arrange_tree() {
		const by_id = new Map(this.tasks.map((t) => [t.id, t]));
		const children = new Map();
		this.tasks.forEach((t) => {
			if (t.parent_id && by_id.has(t.parent_id)) {
				if (!children.has(t.parent_id)) children.set(t.parent_id, []);
				children.get(t.parent_id).push(t);
			}
		});

		const ordered = [];
		const visit = (t) => {
			ordered.push(t);
			(children.get(t.id) || []).forEach(visit);
		};
		this.tasks.forEach((t) => {
			if (!t.parent_id || !by_id.has(t.parent_id)) visit(t);
		});
		this.tasks = ordered;

		const span = (t) => {
			const kids = children.get(t.id) || [];
			if (!kids.length) return;
			let start = null;
			let end = null;
			kids.forEach((k) => {
				span(k);
				if (k.start && (!start || k.start < start)) start = k.start;
				if (k.end && (!end || k.end > end)) end = k.end;
			});
			if (start && end) {
				t.start = start;
				t.end = end;
			}
		};
		this.tasks.forEach((t) => {
			if (!t.parent_id || !by_id.has(t.parent_id)) span(t);
		});

		this.tasks.forEach((t) => {
			if (!t.dependencies) return;
			t.dependencies = t.dependencies
				.split(",")
				.map((id) => id.trim())
				.filter((id) => {
					if (!id) return false;
					const dep = by_id.get(id);
					// a child of this group, or this task's own group
					return !(dep && (dep.parent_id === t.id || t.parent_id === id));
				})
				.join(",");
		});
	}

	render() {
		this.load_lib.then(() => {
			this.render_gantt();
		});
	}

	render_header() {}

	render_gantt() {
		const me = this;
		const gantt_view_mode = this.view_user_settings.gantt_view_mode || "Day";
		const field_map = this.calendar_settings.field_map;
		const date_format = "YYYY-MM-DD";

		// An in-place redraw (refresh_in_place) must not jump: the library scrolls to the oldest
		// task on every render and the container is rebuilt, which would also lose the vertical
		// position. A user-initiated refresh (filter, sort) keeps the library's behaviour.
		const container = this.$result[0].querySelector(".gantt-container");
		const keep_scroll =
			this._keep_scroll && container
				? { top: container.scrollTop, left: container.scrollLeft }
				: null;
		this._keep_scroll = false;

		this.$result.empty();
		this.$result.addClass("gantt-modern");

		this.gantt = new Gantt(this.$result[0], this.tasks, {
			bar_height: 35,
			bar_corner_radius: 4,
			resize_handle_width: 8,
			resize_handle_height: 28,
			resize_handle_corner_radius: 3,
			resize_handle_offset: 4,
			view_mode: gantt_view_mode,
			date_format: "YYYY-MM-DD",
			on_click: (task) => {
				frappe.set_route("Form", task.doctype, task.id);
			},
			on_date_change: (task, start, end) => {
				if (!me.can_write) return;
				me.queue_save(task, {
					[field_map.start]: moment(start).format(date_format),
					[field_map.end]: moment(end).format(date_format),
				}).then(() => {
					// Redraw from the saved data when the chart cannot update itself: a bar the
					// library drew at a placeholder position (dashed, no progress, no handles)
					// because a date was missing now has both; a child's move changes the span
					// its group's summary bar is drawn from (and, with the avantis app, the
					// group's stored dates).
					if (task.invalid || task.parent_id) me.schedule_refresh_in_place();
				});
			},
			on_progress_change: (task, progress) => {
				if (!me.can_write) return;
				var progress_fieldname = "progress";

				if ($.isFunction(field_map.progress)) {
					progress_fieldname = null;
				} else if (field_map.progress) {
					progress_fieldname = field_map.progress;
				}

				if (progress_fieldname) {
					me.queue_save(task, { [progress_fieldname]: parseInt(progress) });
				}
			},
			on_view_change: (mode) => {
				// save view mode
				me.save_view_user_settings({
					gantt_view_mode: mode,
				});
			},
			custom_popup_html: (task) => {
				var item = me.get_item(task.id);

				var dates = task.invalid
					? __("Dates not set: drag the bar to set them")
					: `${moment(task._start).format("MMM D")} - ${moment(task._end).format("MMM D")}`;
				var html = `<div class="title">${task.name}</div>
					<div class="subtitle">${dates}</div>`;

				// custom html in doctype settings
				var custom = me.settings.gantt_custom_popup_html;
				if (custom && $.isFunction(custom)) {
					var ganttobj = task;
					html = custom(ganttobj, item);
				}
				return '<div class="details-container">' + html + "</div>";
			},
		});

		// the library rebuilds bars and arrows on every view-mode change
		const render = this.gantt.render.bind(this.gantt);
		this.gantt.render = () => {
			render();
			this.after_gantt_render();
		};
		// A summary bar's dates are its children's: moving or resizing it means nothing, so
		// the drag never reaches the library (capture phase, before its delegated handler).
		this.gantt.$svg.addEventListener(
			"mousedown",
			(e) => {
				if (e.target.closest && e.target.closest(".bar-wrapper.bar-group")) {
					e.stopPropagation();
				}
			},
			true
		);
		this.setup_dependency_editing();
		this.after_gantt_render();
		if (keep_scroll) {
			const el = this.gantt.$container;
			el.scrollTop = keep_scroll.top;
			el.scrollLeft = keep_scroll.left;
		}
		this.setup_view_mode_buttons();
		this.set_colors();
	}

	// One drag can move several bars (the library carries a bar's dependants along) and it
	// reports each of them separately. Saved concurrently, two of those requests can write
	// the same row — a group's dates follow its children (avantis app) — and MariaDB's
	// snapshot isolation rejects the second as a conflicting update. So save one at a time;
	// a failed save must not hold up the ones behind it.
	queue_save(task, values) {
		const save = () => frappe.db.set_value(task.doctype, task.id, values);
		this._save_chain = (this._save_chain || Promise.resolve()).then(save, save);
		return this._save_chain;
	}

	// several saves from one drag → one redraw, once they have all landed
	schedule_refresh_in_place() {
		clearTimeout(this._refresh_timer);
		this._refresh_timer = setTimeout(() => this.refresh_in_place(), 400);
	}

	after_gantt_render() {
		this.style_group_bars();
		this.bind_placeholder_bars();
		if (this.dependency_config && this.can_write) this.decorate_gantt();
	}

	// Draw a group as a summary bar: a slim dark bar with end caps along the foot of the row,
	// its label above it like a heading, in place of the box the library drew. The arrows
	// that touch it were computed on the box, so re-route them.
	style_group_bars() {
		const groups = this.gantt.bars.filter((bar) => bar.task.is_group);
		if (!groups.length) return;
		const proto = Object.getPrototypeOf(groups[0]);
		if (!proto._group_label_guarded) {
			// the library re-places labels in the next animation frame and after every drag
			const update_label_position = proto.update_label_position;
			proto.update_label_position = function () {
				if (!this.task.is_group) return update_label_position.call(this);
				const label = this.group.querySelector(".bar-label");
				label.classList.add("big");
				label.setAttribute("x", this.$bar.getX());
				label.setAttribute("y", this.$bar.getY() - 10);
			};
			proto._group_label_guarded = true;
		}
		groups.forEach((bar) => {
			const $bar = bar.$bar;
			const x = $bar.getX();
			const w = $bar.getWidth();
			const thickness = 8;
			const top = $bar.getY() + $bar.getHeight() - thickness;
			$bar.setAttribute("y", top);
			$bar.setAttribute("height", thickness);
			$bar.setAttribute("rx", 1);
			$bar.setAttribute("ry", 1);
			if (bar.$bar_progress) bar.$bar_progress.remove();
			[x, x + w].forEach((cx) => {
				svg_el(
					"polygon",
					{
						class: "group-cap",
						points: `${cx - 6},${top} ${cx + 6},${top} ${cx},${top + thickness + 5}`,
					},
					bar.bar_group
				);
			});
			bar.update_label_position();
		});
		this.gantt.arrows.forEach((arrow) => arrow.update());
	}

	// The library skips the click binding for a bar it drew at a placeholder position (a date
	// is missing), so such a task could be dragged but neither its popup nor a double-click
	// to open the form worked. There is no reason for that: bind them like any other bar.
	// Dragging one also threw on every mousemove (the library moves the resize handles and the
	// progress bar it never drew for such a bar), which stopped its arrows following the drag.
	bind_placeholder_bars() {
		this.gantt.bars.forEach((bar) => {
			if (!bar.invalid) return;
			bar.setup_click_event();
			const proto = Object.getPrototypeOf(bar);
			if (!proto._placeholder_guarded) {
				["update_handle_position", "update_progressbar_position"].forEach((name) => {
					const original = proto[name];
					proto[name] = function () {
						if (!this.invalid) original.call(this);
					};
				});
				proto._placeholder_guarded = true;
			}
		});
	}

	// ---- Dependency editing -------------------------------------------------------------
	// The library (frappe-gantt 0.6.x) draws arrows from task.dependencies and offers no way
	// to change them. Everything below decorates its rendered SVG: a link handle at each end
	// of every bar (drag one onto another bar to create a finish-to-start dependency) and a
	// fat invisible twin of every arrow so it can be clicked, selected and removed from a
	// popup. Persistence goes through frappe.client.insert / delete on the child table, so
	// the parent document's validate and on_update run exactly as they do from the form.

	setup_dependency_editing() {
		if (!this.dependency_config || !this.can_write) return;
		const gantt = this.gantt;

		const hide_popup = gantt.hide_popup.bind(gantt);
		gantt.hide_popup = () => {
			hide_popup();
			this.unselect_arrows();
		};

		// While the library moves or resizes a bar our handles cannot follow it, so hide them
		// for the duration (CSS on .bar-moving) and put everything back on mouseup. A link-handle
		// mousedown never reaches the svg (it stops propagation), so linking is unaffected.
		gantt.$svg.addEventListener("mousedown", (e) => {
			const on_bar = e.target.closest && e.target.closest(".bar-wrapper");
			if (on_bar && !e.target.classList.contains("link-handle")) {
				gantt.$svg.classList.add("bar-moving");
			}
		});
		if (this._dependency_mouseup) {
			document.removeEventListener("mouseup", this._dependency_mouseup);
		}
		this._dependency_mouseup = () => {
			if (this.gantt !== gantt) return;
			gantt.$svg.classList.remove("bar-moving");
			this.realign_decorations();
		};
		// document, not svg: a drag may end outside the chart (the library resets there too)
		document.addEventListener("mouseup", this._dependency_mouseup);

		$(gantt.popup_wrapper)
			.off("click.dependency")
			.on("click.dependency", ".remove-dependency", (e) => {
				e.preventDefault();
				const $btn = $(e.currentTarget);
				this.remove_dependency($btn.attr("data-from"), $btn.attr("data-to"));
			});
	}

	decorate_gantt() {
		this.gantt.bars.forEach((bar) => this.draw_link_handles(bar));
		this.gantt.arrows.forEach((arrow) => this.bind_arrow(arrow));
	}

	realign_decorations() {
		this.gantt.bars.forEach((bar) => this.position_link_handles(bar));
		this.gantt.arrows.forEach(
			(arrow) => arrow.hit && arrow.hit.setAttribute("d", arrow.element.getAttribute("d"))
		);
	}

	draw_link_handles(bar) {
		if (bar.invalid || bar.task.is_group) return;
		bar.link_handles = {};
		["start", "end"].forEach((role) => {
			const handle = svg_el(
				"circle",
				{ class: "link-handle " + role, r: 5, "data-role": role },
				bar.handle_group
			);
			// stop the library treating this as the start of a bar drag, or as a bar click
			handle.addEventListener("mousedown", (e) => {
				e.stopPropagation();
				e.preventDefault();
				this.start_link_drag(bar, role, e);
			});
			handle.addEventListener("click", (e) => e.stopPropagation());
			bar.link_handles[role] = handle;
		});
		this.position_link_handles(bar);
	}

	// Handles sit where the library's arrows attach: the START (incoming) handle just left of
	// the bar at mid-height, where an arrow arrives; the END (outgoing) handle centred just
	// below the bar, where an arrow leaves. That also keeps the end handle clear of a label
	// drawn beside a short bar.
	position_link_handles(bar) {
		if (!bar.link_handles) return;
		const $bar = bar.$bar;
		const r = +bar.link_handles.start.getAttribute("r");
		bar.link_handles.start.setAttribute("cx", $bar.getX() - r - 3);
		bar.link_handles.start.setAttribute("cy", $bar.getY() + $bar.getHeight() / 2);
		bar.link_handles.end.setAttribute("cx", $bar.getX() + $bar.getWidth() / 2);
		bar.link_handles.end.setAttribute("cy", $bar.getY() + $bar.getHeight() + r + 2);
	}

	// Drag from a bar's END handle onto another bar: that bar will depend on this one.
	// Drag from a bar's START handle onto another bar: this bar will depend on that one.
	start_link_drag(bar, role, e) {
		const gantt = this.gantt;
		gantt.hide_popup();
		const handle = bar.link_handles[role];
		const origin = { x: +handle.getAttribute("cx"), y: +handle.getAttribute("cy") };
		const line = svg_el(
			"path",
			{ class: "link-drag-line", d: `M ${origin.x} ${origin.y} L ${origin.x} ${origin.y}` },
			gantt.layers.arrow
		);
		gantt.$svg.classList.add("linking");

		const move = (ev) => {
			const p = this.svg_point(ev);
			line.setAttribute("d", `M ${origin.x} ${origin.y} L ${p.x} ${p.y}`);
			this.highlight_drop_target(this.bar_at(p), bar);
		};
		const finish = (ev) => {
			const target = this.bar_at(this.svg_point(ev));
			cleanup();
			if (!target || target === bar) return;
			const [from, to] = role === "end" ? [bar, target] : [target, bar];
			this.add_dependency(from.task.id, to.task.id);
		};
		const cancel = (ev) => {
			if (ev.key === "Escape") cleanup();
		};
		const cleanup = () => {
			line.remove();
			gantt.$svg.classList.remove("linking");
			this.highlight_drop_target(null);
			document.removeEventListener("mousemove", move);
			document.removeEventListener("mouseup", finish);
			document.removeEventListener("keydown", cancel);
		};
		document.addEventListener("mousemove", move);
		document.addEventListener("mouseup", finish);
		document.addEventListener("keydown", cancel);
	}

	svg_point(ev) {
		const svg = this.gantt.$svg;
		const pt = svg.createSVGPoint();
		pt.x = ev.clientX;
		pt.y = ev.clientY;
		return pt.matrixTransform(svg.getScreenCTM().inverse());
	}

	// The bar itself, or either of its link handles (with some slack): a drop on the target's
	// circle is the natural gesture, so it must count as the bar.
	bar_at(p) {
		return (
			this.gantt.bars.find((bar) => {
				if (bar.invalid) return false;
				const b = bar.$bar;
				if (
					p.x >= b.getX() - 4 &&
					p.x <= b.getEndX() + 4 &&
					p.y >= b.getY() &&
					p.y <= b.getY() + b.getHeight()
				) {
					return true;
				}
				return Object.values(bar.link_handles || {}).some((h) => {
					const dx = p.x - +h.getAttribute("cx");
					const dy = p.y - +h.getAttribute("cy");
					const r = +h.getAttribute("r") + 4;
					return dx * dx + dy * dy <= r * r;
				});
			}) || null
		);
	}

	highlight_drop_target(target, source) {
		this.gantt.bars.forEach((bar) =>
			bar.group.classList.toggle("link-target", !!target && bar === target && bar !== source)
		);
	}

	bind_arrow(arrow) {
		// the visible arrow is a 1.4px stroke; give it an invisible fat twin to click on
		arrow.hit = svg_el(
			"path",
			{ class: "arrow-hit", d: arrow.element.getAttribute("d") },
			this.gantt.layers.arrow
		);
		arrow.hit.addEventListener("click", (e) => {
			e.stopPropagation();
			this.select_arrow(arrow);
		});
	}

	select_arrow(arrow) {
		this.gantt.unselect_all();
		this.unselect_arrows();
		arrow.element.classList.add("active");
		this.show_arrow_popup(arrow);
	}

	unselect_arrows() {
		(this.gantt.arrows || []).forEach((a) => a.element.classList.remove("active"));
	}

	task_label(id) {
		const item = this.get_item(id);
		const title = item && this.meta.title_field && item[this.meta.title_field];
		return frappe.utils.escape_html(title ? `${title} (${id})` : id);
	}

	show_arrow_popup(arrow) {
		const gantt = this.gantt;
		const from = arrow.from_task.task;
		const to = arrow.to_task.task;
		const html = `<div class="details-container dependency-popup">
			<div class="title">${__("Dependency")}</div>
			<div class="subtitle">${__("{0} must finish before {1} can start", [
				`<b>${this.task_label(from.id)}</b>`,
				`<b>${this.task_label(to.id)}</b>`,
			])}</div>
			<button class="btn btn-xs btn-default remove-dependency"
				data-from="${from.id}" data-to="${to.id}">${__("Remove dependency")}</button>
		</div>`;

		// the library builds its Popup lazily with the task html; borrow it for the arrow
		if (!gantt.popup) gantt.show_popup({ target_element: arrow.hit, task: to });
		const popup = gantt.popup;
		const original = popup.custom_html;
		popup.custom_html = () => html;
		popup.show({ target_element: arrow.hit, position: "left", task: to });
		popup.custom_html = original;
	}

	// Re-fetch and redraw after the chart itself changed a document (dependency, dates),
	// keeping the scroll position. BaseList.refresh() drops a call whose query arguments match
	// the previous one within three seconds (throttling for realtime updates). Ours are
	// identical by construction — only the data changed — so clear the memo first.
	refresh_in_place() {
		this._keep_scroll = true;
		this.last_args = null;
		return this.refresh();
	}

	add_dependency(from_id, to_id) {
		const cfg = this.dependency_config;
		const to_task = this.gantt.get_task(to_id);
		if (to_task && (to_task.dependencies || []).includes(from_id)) {
			frappe.show_alert({
				message: __("{0} already depends on {1}", [to_id, from_id]),
				indicator: "orange",
			});
			return;
		}
		const doc = {
			doctype: cfg.child_doctype,
			parenttype: this.doctype,
			parent: to_id,
			parentfield: cfg.parentfield,
			[cfg.link_field]: from_id,
		};
		// frappe.client.insert appends the row to the parent and saves it, so the parent's
		// validate/on_update run (circular check, rescheduling of dependants, ...)
		return frappe
			.xcall("frappe.client.insert", { doc })
			.then(() =>
				frappe.show_alert({
					message: __("{0} now depends on {1}", [to_id, from_id]),
					indicator: "green",
				})
			)
			.finally(() => this.refresh_in_place());
	}

	remove_dependency(from_id, to_id) {
		const cfg = this.dependency_config;
		this.gantt.hide_popup();
		return frappe
			.xcall("frappe.client.get_list", {
				doctype: cfg.child_doctype,
				parent: this.doctype,
				fields: ["name"],
				filters: { parenttype: this.doctype, parent: to_id, [cfg.link_field]: from_id },
				limit_page_length: 1,
			})
			.then((rows) => {
				if (!rows.length) return;
				// frappe.client.delete removes a child row through its parent, so on_update runs
				return frappe.xcall("frappe.client.delete", {
					doctype: cfg.child_doctype,
					name: rows[0].name,
				});
			})
			.then(() => frappe.show_alert({ message: __("Dependency removed"), indicator: "green" }))
			.finally(() => this.refresh_in_place());
	}

	// ---- end dependency editing ---------------------------------------------------------

	setup_view_mode_buttons() {
		// view modes (for translation) __("Day"), __("Week"), __("Month"),
		//__("Half Day"), __("Quarter Day")

		let $btn_group = this.$paging_area.find(".gantt-view-mode");
		if ($btn_group.length > 0) return;

		const view_modes = this.gantt.options.view_modes || [];
		const active_class = (view_mode) => (this.gantt.view_is(view_mode) ? "btn-info" : "");
		const html = `<div class="btn-group gantt-view-mode mx-2">
				${view_modes
					.map(
						(value) => `<button type="button"
						class="btn btn-default btn-sm btn-view-mode ${active_class(value)}"
						data-value="${value}">
						${__(value)}
					</button>`
					)
					.join("")}
			</div>`;

		this.$paging_area.find(".level-left").append(html);

		// change view mode asynchronously
		const change_view_mode = (value) =>
			setTimeout(() => this.gantt.change_view_mode(value), 0);

		this.$paging_area.on("click", ".btn-view-mode", (e) => {
			const $btn = $(e.currentTarget);
			this.$paging_area.find(".btn-view-mode").removeClass("btn-info");
			$btn.addClass("btn-info");

			const value = $btn.data().value;
			change_view_mode(value);
		});
	}

	set_colors() {
		const classes = this.tasks
			.map((t) => t.custom_class)
			.filter((c) => c && c.startsWith("color-"));

		let style = classes
			.map((c) => {
				const class_name = c.replace("#", "");
				const bar_color = "#" + c.substr(6);
				const progress_color = frappe.ui.color.get_contrast_color(bar_color);
				return `
				.gantt .bar-wrapper.${class_name} .bar {
					fill: ${bar_color};
				}
				.gantt .bar-wrapper.${class_name} .bar-progress {
					fill: ${progress_color};
				}
			`;
			})
			.join("");

		style = `<style>${style}</style>`;
		this.$result.prepend(style);
	}

	get_item(name) {
		return this.data.find((item) => item.name === name);
	}

	get required_libs() {
		return [
			"assets/frappe/node_modules/frappe-gantt/dist/frappe-gantt.css",
			"assets/frappe/node_modules/frappe-gantt/dist/frappe-gantt.min.js",
		];
	}
};
