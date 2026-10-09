frappe.provide("frappe.views");

const DEFAULT_FIELD_MAP = {
	start: "start",
	end: "end",
	id: "name",
	progress: "progress",
	color: "color",
	is_milestone: "is_milestone",
	depends_on: "depends_on_tasks",
};

// Minimal SVG element factory (the gantt library's own createSVG is not exported).
function svg_el(tag, attrs, parent) {
	const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
	Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
	if (parent) parent.appendChild(el);
	return el;
}

// Keep a bar's assignee avatars just left of it: clear of the start link handle and of the
// head of an incoming arrow. A task in the chart's first column has no room there, so its
// avatars stay on the chart and overlap the start of the bar instead of being cut off.
const ASSIGNEE_GROUP_WIDTH = 120;
function place_assignees(bar) {
	if (!bar.$assignees) return;
	const right = Math.max(bar.$bar.getX() - 20, bar.assignees_width + 2);
	bar.$assignees.setAttribute("x", right - ASSIGNEE_GROUP_WIDTH);
	bar.$assignees.setAttribute("y", bar.$bar.getY());
}

// AvantisEd (avn-main) extends upstream's Gantt view with: tree doctypes drawn as a tree
// (groups as summary bars over their children), undated tasks shown as placeholder bars,
// dependency editing (link handles, clickable arrows), assignee avatars, a doctype hook for
// bar colour / default zoom / extra fields, saves serialised one at a time, and 500 rows.
// Each is marked "avn-main" below. Ported from frappe-gantt 0.6 to 1.1 on 2026-10-09.
frappe.views.GanttView = class GanttView extends frappe.views.ListView {
	get view_name() {
		return "Gantt";
	}

	setup_defaults() {
		return super
			.setup_defaults()
			.then(() => {
				this.page_title = this.page_title + " " + __("Gantt");
				// A plan is read whole: the list's 20 rows cut a chart off mid-workstream with
				// only a Load More button below to say so (avn-main).
				this.page_length = this.selected_page_count = 500;
				this.calendar_settings = frappe.views.calendar[this.doctype] || {};
				this.calendar_settings.field_map = {
					...DEFAULT_FIELD_MAP,
					...(this.calendar_settings.field_map || {}),
				};

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

	setup_view() {
		// The list's own setup_view binds row events the chart has no rows for; only the
		// filterable click is wanted, so an assignee avatar filters the chart (avn-main).
		this.setup_filterable();
	}

	get_fields() {
		// Add necessary fields for Gantt
		let fields = super.get_fields();
		const field_map = this.calendar_settings.field_map || DEFAULT_FIELD_MAP;
		const meta = this.meta;

		const gantt_fields = [
			field_map.start,
			field_map.end,
			field_map.progress,
			field_map.id,
			field_map.title,
			field_map.color,
			field_map.is_milestone,
			field_map.depends_on,
			// avn-main: the parent link for tree doctypes, the assignees, and whatever the
			// doctype's get_color reads
			this.parent_field,
			this.parent_field && "is_group",
			"_assign",
			...(this.calendar_settings.fields || []),
		].filter((f) => typeof f === "string");
		gantt_fields.forEach((fieldname) => {
			let full_fieldname = frappe.model.get_full_column_name(fieldname, this.doctype);
			if (
				!fields.includes(full_fieldname) &&
				(fieldname === "_assign" || meta.fields.find((f) => f.fieldname === fieldname))
			) {
				fields.push(full_fieldname);
			}
		});
		return fields;
	}

	get parent_field() {
		return this.meta.is_tree ? this.meta.nsm_parent_field : null;
	}

	prepare_data(data) {
		super.prepare_data(data);
		this.prepare_tasks();
	}

	prepare_tasks() {
		var me = this;
		var meta = this.meta;
		let field_map = this.calendar_settings.field_map || DEFAULT_FIELD_MAP;
		// A bar's colour (avn-main): the doctype's Gantt settings may derive it from the
		// document, e.g. from its status, via get_color(item) -> hex. Otherwise, as upstream,
		// its color field. Derived at render time, so a status written without a save (ERPNext's
		// overdue job uses db_set) still colours the bar.
		const get_color = this.calendar_settings.get_color;
		const today = frappe.datetime.get_today();

		if (!this.data[0]?.[field_map.progress]) {
			this.progress_disabled = true;
		}

		if (!this.meta.fields.find((k) => k.fieldname === field_map.start)) {
			frappe.msgprint({
				title: __("Incorrect configuration"),
				message: __(
					"Please configure the start field for this Doctype in the controller file."
				),
				indicator: "red",
			});
		}
		this.tasks = this.data.map(function (item) {
			// set progress
			var progress = 0;
			if (typeof field_map.progress === "function") {
				progress = field_map.progress(item);
			} else if (field_map.progress) {
				progress = item[field_map.progress];
			}

			// title
			let label;
			if (field_map.title) {
				label = item[field_map.title];
			} else if (meta.title_field) {
				label = item.progress
					? __("{0} ({1}) - {2}%", [item[meta.title_field], item.name, item.progress])
					: __("{0} ({1})", [item[meta.title_field], item.name]);
			} else {
				label = item["name"];
			}

			// Placeholder bars (avn-main): frappe-gantt 1.1 drops a task with no date and keeps
			// the array index it gave every task, so each later task's arrows then point at the
			// wrong bar (or at none, which throws and leaves the chart empty). A task missing a
			// date is drawn instead: one day at whichever date it has, else today, dashed, and
			// dragging it sets the dates it lacks.
			let start = item[field_map.start];
			let end = item[field_map.end];
			const placeholder = !start || !end;
			start = start || end || today;
			end = end || start;

			const r = {
				start: start,
				end: end,
				name: label,
				id: item[field_map.id],
				doctype: me.doctype,
				progress: progress,
				dependencies: "",
				placeholder: placeholder,
			};

			if (field_map.depends_on) {
				r.dependencies = item[field_map.depends_on] || "";
			}
			// a group is drawn as a summary bar in its own colour, whatever its status (avn-main)
			const color =
				me.parent_field && item.is_group
					? null
					: get_color
					? get_color(item)
					: field_map.color && item[field_map.color];
			if (color && frappe.ui.color.validate_hex(color)) {
				r["custom_class"] = "color-" + color.substr(1);
			}
			if (field_map.is_milestone && item[field_map.is_milestone]) {
				r["custom_class"] = "bar-milestone";
			}
			// bar-group / bar-placeholder go on in mark_bars: frappe-gantt 1.1 adds custom_class
			// as a single class token, so it carries the colour only
			if (me.parent_field) {
				r.is_group = !!item.is_group;
				r.parent_id = item[me.parent_field] || null;
			}

			return r;
		});

		if (this.parent_field) this.arrange_tree();
		this.prune_missing_dependencies();
	}

	// A predecessor that is not on the chart -- filtered out, or past the loaded page -- has no
	// bar, and frappe-gantt dereferences one for every arrow it draws and on every mousemove of
	// a drag (Bar.update_bar_position), so it throws and the chart stays empty or the bar
	// freezes. Drop those ids: a constraint the user cannot see should not break the chart.
	// Predecessors that ARE on the chart still constrain it (avn-main).
	prune_missing_dependencies() {
		const loaded = new Set(this.tasks.map((t) => t.id));
		this.tasks.forEach((t) => {
			if (!t.dependencies) return;
			t.dependencies = String(t.dependencies)
				.split(",")
				.map((id) => id.trim())
				.filter((id) => id && loaded.has(id))
				.join(",");
		});
	}

	// Groups as summary rows (avn-main): each group is followed by its children (recursively, in
	// the list's own order), spans its children's dates, and the arrows that merely encode
	// containment are dropped. ERPNext appends every child to its parent's depends_on on save,
	// so without this a group shows an arrow from each of its children; the rows stay in the
	// data (they stop a group being completed before its children), only the chart leaves
	// them out. A child whose parent is not loaded stays where the list put it.
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

		// a group's span comes from its dated children; placeholder children do not stretch it
		const span = (t) => {
			const kids = children.get(t.id) || [];
			if (!kids.length) return;
			let start = null;
			let end = null;
			kids.forEach((k) => {
				span(k);
				if (k.placeholder) return;
				if (!start || k.start < start) start = k.start;
				if (!end || k.end > end) end = k.end;
			});
			if (start && end) {
				t.start = start;
				t.end = end;
				t.placeholder = false;
			}
		};
		this.tasks.forEach((t) => {
			if (!t.parent_id || !by_id.has(t.parent_id)) span(t);
		});

		this.tasks.forEach((t) => {
			if (!t.dependencies) return;
			t.dependencies = String(t.dependencies)
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
		// The mode a user last picked, else the doctype's Gantt settings' view_mode (avn-main)
		const gantt_view_mode =
			this.view_user_settings.gantt_view_mode || this.calendar_settings.view_mode || "Day";
		const field_map = this.calendar_settings.field_map;
		const date_format = "YYYY-MM-DD";

		// An in-place redraw (refresh_in_place) must not jump: the library scrolls on every
		// render and the container is rebuilt. A user-initiated refresh (filter, sort) keeps the
		// library's behaviour (avn-main).
		const container = this.$result[0].querySelector(".gantt-container");
		const keep_scroll =
			this._keep_scroll && container
				? { top: container.scrollTop, left: container.scrollLeft }
				: null;
		this._keep_scroll = false;

		this.$result.empty();
		this.gantt = new Gantt(this.$result[0], this.tasks, {
			bar_height: 35,
			bar_corner_radius: 4,
			hover_on_date: true,
			view_mode: gantt_view_mode,
			date_format: "YYYY-MM-DD",
			readonly: !me.can_write,
			readonly_progress: this.progress_disabled,
			fixed_duration: field_map.start === field_map.end,
			on_double_click: (task) => {
				frappe.set_route("Form", task.doctype, task.id);
			},
			on_date_click: (date) => {
				if (date) frappe.new_doc("ToDo", { date: new Date(date) });
			},
			on_date_change: (task, start, end) => {
				if (!me.can_write) return;
				// A summary bar's dates are its children's (avn-main); the drag is blocked below
				if (task.is_group) return;
				me.queue_save(task, {
					[field_map.start]: moment(start).format(date_format),
					[field_map.end]: moment(end).format(date_format),
				}).then(() => {
					// Redraw from the saved data when the chart cannot update itself: a
					// placeholder now has real dates, and a child's move changes the span its
					// group's summary bar is drawn from (avn-main)
					if (task.placeholder || task.parent_id) me.schedule_refresh_in_place();
				});
			},
			on_progress_change: (task, progress) => {
				if (!me.can_write) return;
				let progress_fieldname;

				if (typeof field_map.progress === "function") {
					progress_fieldname = null;
				} else if (field_map.progress) {
					progress_fieldname = field_map.progress;
				}

				if (progress_fieldname) {
					me.queue_save(task, {
						[progress_fieldname]: parseInt(progress),
					});
				}
			},
			on_view_change: (mode) => {
				// save view mode
				me.save_view_user_settings({
					gantt_view_mode: mode.name,
				});
			},
			popup: ({ task }) => {
				// the dependency popup borrows the library's popup (avn-main)
				if (me._arrow_popup_html) return me._arrow_popup_html;

				var item = me.get_item(task.id);
				var dates = task.placeholder
					? __("Dates not set: drag the bar to set them")
					: `${moment(task._start).format("MMM D")} - ${moment(task.end).format(
							"MMM D"
					  )}`;
				var html = `<div class="title">${frappe.utils.escape_html(task.name)}</div>
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

		// The library rebuilds bars and arrows on every render (view-mode change, and while
		// scrolling past either edge with infinite padding), so decorate after each (avn-main)
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
		this.reveal_first_assignees();
		if (keep_scroll) {
			const el = this.gantt.$container;
			el.scrollTop = keep_scroll.top;
			el.scrollLeft = keep_scroll.left;
		}
		this.setup_view_mode_buttons();
		this.set_colors();
	}

	// One drag can move several bars (the library carries a bar's dependants along) and it
	// reports each of them separately. Saved concurrently, two of those requests can write the
	// same row -- a group's dates follow its children (avantis app) -- and MariaDB rejects the
	// second as a conflicting update. So save one at a time; a failed save must not hold up the
	// ones behind it (avn-main).
	queue_save(task, values) {
		const save = () => frappe.db.set_value(task.doctype, task.id, values);
		this._save_chain = (this._save_chain || Promise.resolve()).then(save, save);
		return this._save_chain;
	}

	// several saves from one drag -> one redraw, once they have all landed
	schedule_refresh_in_place() {
		clearTimeout(this._refresh_timer);
		this._refresh_timer = setTimeout(() => this.refresh_in_place(), 400);
	}

	after_gantt_render() {
		this.mark_bars();
		this.style_group_bars();
		this.draw_assignees();
		if (this.dependency_config && this.can_write) this.decorate_gantt();
	}

	// Classes our styles and handlers key on, which custom_class cannot carry (avn-main)
	mark_bars() {
		this.gantt.bars.forEach((bar) => {
			bar.group.classList.toggle("bar-group", !!bar.task.is_group);
			bar.group.classList.toggle("bar-placeholder", !!bar.task.placeholder);
		});
	}

	// Draw a group as a summary bar (avn-main): a slim dark bar with end caps along the foot of
	// the row, its label above it like a heading, in place of the box the library drew. The
	// arrows that touch it were computed on the box, so re-route them.
	style_group_bars() {
		const groups = this.gantt.bars.filter((bar) => bar.task.is_group);
		if (!groups.length) return;
		const proto = Object.getPrototypeOf(groups[0]);
		if (!proto._group_label_guarded) {
			// the library re-places labels after every drag and horizontal scroll
			const update_label_position = proto.update_label_position;
			proto.update_label_position = function () {
				if (!this.task.is_group) return update_label_position.call(this);
				const label = this.group.querySelector(".bar-label");
				if (!label) return;
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

	// Who holds each task (avn-main): the Kanban card's avatar group, left of the bar. SVG
	// cannot lay out the HTML avatars, so each group sits in a foreignObject, in a layer of its
	// own above the arrows and below the bars. The library re-renders the whole svg on every
	// view-mode change, so the layer is rebuilt each time; during a drag the avatars follow
	// the bar through its update_bar_position.
	draw_assignees() {
		const gantt = this.gantt;
		if (!gantt.bars.length) return;
		const proto = Object.getPrototypeOf(gantt.bars[0]);
		if (!proto._assignees_follow) {
			const update_bar_position = proto.update_bar_position;
			proto.update_bar_position = function (...args) {
				update_bar_position.apply(this, args);
				place_assignees(this);
			};
			proto._assignees_follow = true;
		}

		const layer = svg_el("g", { class: "assignee-layer" });
		gantt.$svg.insertBefore(layer, gantt.layers.arrow.nextSibling);
		gantt.bars.forEach((bar) => {
			const item = this.get_item(bar.task.id);
			const users = item && item._assign ? JSON.parse(item._assign) : [];
			bar.$assignees = null;
			if (!users.length) return;
			const holder = svg_el(
				"foreignObject",
				{ class: "assignees", width: ASSIGNEE_GROUP_WIDTH, height: bar.height },
				layer
			);
			// side by side, not overlapped as on a Kanban card: initials must read at a glance
			holder.appendChild(
				frappe.avatar_group(users, 3, {
					align: "left",
					overlap: false,
					filterable: true,
				})[0]
			);
			// avatar_group shows 3 and a "+N" chip, or all 4 when there is only one more
			const shown = Math.min(users.length, 4);
			bar.assignees_width = shown * 28;
			bar.$assignees = holder;
			place_assignees(bar);
		});
	}

	// The library scrolls the chart to today, which can hide the avatars of a task starting
	// at the left edge of the view; nudge left far enough to show the widest group. Only on a
	// fresh render: an in-place redraw restores its own scroll position (avn-main).
	reveal_first_assignees() {
		const widest = Math.max(0, ...this.gantt.bars.map((bar) => bar.assignees_width || 0));
		if (widest) this.gantt.$container.scrollLeft -= widest + 24;
	}

	// ---- Dependency editing (avn-main) --------------------------------------------------
	// The library draws arrows from task.dependencies and offers no way to change them.
	// Everything below decorates its rendered SVG: a link handle at each end of every bar (drag
	// one onto another bar to create a finish-to-start dependency) and a fat invisible twin of
	// every arrow so it can be clicked, selected and removed from a popup. Persistence goes
	// through frappe.client.insert / delete on the child table, so the parent document's
	// validate and on_update run exactly as they do from the form.

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

		$(gantt.$popup_wrapper)
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
		if (bar.task.is_group) return;
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
			handle.addEventListener("mouseup", (e) => e.stopPropagation());
			handle.addEventListener("click", (e) => e.stopPropagation());
			bar.link_handles[role] = handle;
		});
		this.position_link_handles(bar);
	}

	// Handles sit where the library's arrows attach: the START (incoming) handle just left of
	// the bar at mid-height, where an arrow arrives; the END (outgoing) handle centred just
	// below the bar, where an arrow leaves.
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
	start_link_drag(bar, role) {
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
				if (bar.task.is_group) return false;
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
		// the visible arrow is a thin stroke; give it an invisible fat twin to click on
		arrow.hit = svg_el(
			"path",
			{ class: "arrow-hit", d: arrow.element.getAttribute("d") },
			this.gantt.layers.arrow
		);
		arrow.hit.addEventListener("click", (e) => {
			e.stopPropagation();
			this.select_arrow(arrow, e);
		});
		// keep the twin on the arrow when the library re-routes it during a drag
		const update = arrow.update.bind(arrow);
		arrow.update = () => {
			update();
			arrow.hit && arrow.hit.setAttribute("d", arrow.element.getAttribute("d"));
		};
	}

	select_arrow(arrow, e) {
		this.gantt.unselect_all();
		this.unselect_arrows();
		arrow.element.classList.add("active");
		this.show_arrow_popup(arrow, e);
	}

	unselect_arrows() {
		(this.gantt.arrows || []).forEach((a) => a.element.classList.remove("active"));
	}

	task_label(id) {
		const item = this.get_item(id);
		const title = item && this.meta.title_field && item[this.meta.title_field];
		return frappe.utils.escape_html(title ? `${title} (${id})` : id);
	}

	show_arrow_popup(arrow, e) {
		const from = arrow.from_task.task;
		const to = arrow.to_task.task;
		this._arrow_popup_html = `<div class="details-container dependency-popup">
			<div class="title">${__("Dependency")}</div>
			<div class="subtitle">${__("{0} must finish before {1} can start", [
				`<b>${this.task_label(from.id)}</b>`,
				`<b>${this.task_label(to.id)}</b>`,
			])}</div>
			<button class="btn btn-xs btn-default remove-dependency"
				data-from="${from.id}" data-to="${to.id}">${__("Remove dependency")}</button>
		</div>`;
		const p = this.svg_point(e);
		try {
			this.gantt.show_popup({ x: p.x, y: p.y, task: to, target: arrow.hit });
		} finally {
			this._arrow_popup_html = null;
		}
	}

	// Re-fetch and redraw after the chart itself changed a document (dependency, dates),
	// keeping the scroll position. BaseList.refresh() drops a call whose query arguments match
	// the previous one within three seconds (throttling for realtime updates). Ours are
	// identical by construction -- only the data changed -- so clear the memo first.
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

		if (this.$paging_area.find(".gantt-view-mode").length > 0) return;

		const view_modes = this.gantt.options.view_modes || [];
		// frappe-gantt 1.1 defines view_is twice and the later one compares options.view_mode
		// (a string) by .name, so it never matches; read the current mode instead (avn-main)
		const current = this.gantt.config.view_mode?.name;
		const active = view_modes.find((mode) => mode.name === current);
		const view_mode_group = new frappe.ui.TabButtons({
			label: __("Gantt View Mode"),
			css_class: "gantt-view-mode ms-2 me-2",
			options: view_modes.map((mode) => ({
				label: __(mode.name),
				value: mode.name,
			})),
			value: active && active.name,
			// change view mode asynchronously
			on_change: (value) => setTimeout(() => this.gantt.change_view_mode(value), 0),
		});
		this.$paging_area.find(".level-left").append(view_mode_group.$el);
	}

	set_colors() {
		const classes = this.tasks
			.map((t) => t.custom_class)
			.filter((c) => c && c.startsWith("color-"));

		let style = [...new Set(classes)]
			.map((c) => {
				const class_name = c.replace("#", "");
				const bar_color = "#" + c.substr(6);
				const progress_color = frappe.ui.color.get_contrast_color(bar_color);
				// Half-opaque progress overlay (avn-main): bars may be coloured by status, and a
				// solid contrast shade over the done fraction hid that colour entirely on a
				// finished task (progress 100%). At 0.5 the bar's colour shows through.
				return `
				.gantt .bar-wrapper.${class_name} .bar {
					fill: ${bar_color};
				}
				.gantt .bar-wrapper.${class_name} .bar-progress {
					fill: ${progress_color};
					fill-opacity: 0.5;
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
			"assets/frappe/node_modules/frappe-gantt/dist/frappe-gantt.umd.js",
		];
	}
};
