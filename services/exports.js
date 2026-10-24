const ExcelJS = require('exceljs');
const db = require('../db');
const { timezone: TZ } = require('../config');
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function formatDateCn(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(`${date}T12:00:00+08:00`)).replace(/(周[一二三四五六日])$/, ' $1');
}

function formatDateTime(iso) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function statusLabel(status) {
  return db.STATUS_LABELS[status] || status;
}

function priorityLabel(priority) {
  return { high: '高', medium: '中', low: '低' }[priority] || priority;
}

function mdEscape(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/([*_])/g, '\\$1')
    .replace(/\n/g, '\n  ');
}

function statusSummary(counts) {
  const order = ['doing', 'paused', 'blocked', 'done', 'todo'];
  return order
    .filter((key) => counts[key])
    .map((key) => `${statusLabel(key)} ${counts[key]}`)
    .join(' · ');
}

function ensureBlank(lines) {
  if (lines.length && lines[lines.length - 1] !== '') lines.push('');
}

function resolveRange(query) {
  const today = db.todayStr();
  if (query.date) {
    if (!db.isDate(query.date)) throw new HttpError(400, '日期格式应为 YYYY-MM-DD');
    return { from: query.date, to: query.date, single: true };
  }

  let from = query.from || today;
  let to = query.to || from;
  if (!db.isDate(from) || !db.isDate(to)) throw new HttpError(400, '日期格式应为 YYYY-MM-DD');
  if (from > to) [from, to] = [to, from];
  if (Math.abs(db.diffDays(from, to)) > 366) throw new HttpError(400, '导出范围不能超过 366 天');
  return { from, to, single: false };
}

function actorNote(actor, owner) {
  return actor && owner && actor !== owner ? `（更新人：${mdEscape(actor)}）` : '';
}

function buildMarkdown({ from, to, single }, memberId) {
  const memberFilter = memberId ? db.listMembers().find((m) => Number(m.id) === Number(memberId)) : null;
  const lines = [];

  if (single) {
    const day = db.getDay(from);
    if (memberId) {
      day.members = day.members.filter(member => Number(member.id) === memberId);
      const updates = day.members.flatMap(member => member.updates);
      day.summary.membersUpdated = day.members.filter(member => member.updates.length).length;
      day.summary.updates = updates.length;
      day.summary.statusCounts = {};
      for (const update of new Map(updates.map(update => [update.item_id, update])).values()) {
        day.summary.statusCounts[update.status] = (day.summary.statusCounts[update.status] || 0) + 1;
      }
    }
    const summaryParts = [`${day.summary.membersUpdated} 人更新`, `${day.summary.updates} 条记录`];
    if (statusSummary(day.summary.statusCounts)) summaryParts.push(statusSummary(day.summary.statusCounts));

    lines.push(`# 团队工作日报 · ${formatDateCn(from)}`, '');
    lines.push(`> ${summaryParts.join(' · ')}`, '');

    for (const member of day.members) {
      if (!member.updates.length) continue;
      lines.push(`## ${member.name}${member.role ? ` · ${member.role}` : ''}`, '');
      for (const update of member.updates) {
        lines.push(
          `- **${mdEscape(update.title)}**${update.project ? `（${mdEscape(update.project)}）` : ''} — ${statusLabel(update.status)} ${update.progress}%${actorNote(update.actor_name, member.name)}`
        );
        if (update.note) lines.push(`  - ${mdEscape(update.note)}`);
      }
      lines.push('');
    }

    const silent = day.members.filter((m) => m.updates.length === 0);
    if (silent.length) {
      lines.push('## 今日无更新', '');
      for (const member of silent) {
        lines.push(`- ${member.name}${member.role ? `（${member.role}）` : ''}：进行中/搁置/阻塞事项 ${member.active_count} 项`);
      }
      lines.push('');
    }
    return `${lines.join('\n').trim()}\n\n---\n由 Team Tracker 生成 · ${formatDateTime(new Date().toISOString())}\n`;
  }

  const rows = db.getExportRows(from, to, memberId);
  if (rows.length > 10000) throw new HttpError(413, '更新记录过多，请缩小日期范围');
  lines.push(`# 团队工作汇总 · ${from} ~ ${to}`, '');
  lines.push(`> 共 ${rows.length} 条更新${memberFilter ? ` · 成员：${memberFilter.name}` : ''}`, '');

  if (!rows.length) {
    lines.push('该时间段内没有更新记录。', '');
    return `${lines.join('\n').trim()}\n`;
  }

  let currentDate = null;
  let currentMember = null;
  for (const row of rows) {
    if (row.date !== currentDate) {
      ensureBlank(lines);
      lines.push(`## ${formatDateCn(row.date)}`, '');
      currentDate = row.date;
      currentMember = null;
    }
    if (row.member !== currentMember) {
      ensureBlank(lines);
      lines.push(`### ${row.member}${row.role ? ` · ${row.role}` : ''}`, '');
      currentMember = row.member;
    }
    lines.push(
      `- **${mdEscape(row.title)}**${row.project ? `（${mdEscape(row.project)}）` : ''} — ${statusLabel(row.status)} ${row.progress}%${actorNote(row.actor, row.member)}`
    );
    if (row.note) lines.push(`  - ${mdEscape(row.note)}`);
  }

  return `${lines.join('\n').trim()}\n\n---\n由 Team Tracker 生成 · ${formatDateTime(new Date().toISOString())}\n`;
}

function styleHeader(ws) {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
  row.alignment = { vertical: 'middle' };
  row.height = 24;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
}

async function buildWorkbook({ from, to }, memberId) {
  const rows = db.getExportRows(from, to, memberId);
  if (rows.length > 10000) throw new HttpError(413, '更新记录过多，请缩小日期范围');
  const members = db.listMembers();
  const items = db.listItems(memberId ? { member_id: memberId } : {});
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Team Tracker';
  workbook.created = new Date();

  const updates = workbook.addWorksheet('工作更新');
  updates.columns = [
    { header: '日期', key: 'date', width: 12 },
    { header: '成员', key: 'member', width: 10 },
    { header: '角色', key: 'role', width: 10 },
    { header: '更新人', key: 'actor', width: 10 },
    { header: '事项', key: 'title', width: 30 },
    { header: '项目', key: 'project', width: 16 },
    { header: '状态', key: 'status', width: 10 },
    { header: '进度', key: 'progress', width: 8 },
    { header: '更新内容', key: 'note', width: 48 },
    { header: '记录时间', key: 'created_at', width: 20 },
  ];
  for (const row of rows) {
    updates.addRow({
      date: row.date,
      member: row.member,
      role: row.role,
      actor: row.actor,
      title: row.title,
      project: row.project,
      status: statusLabel(row.status),
      progress: row.progress,
      note: row.note,
      created_at: formatDateTime(row.created_at),
    });
  }
  updates.getColumn('progress').numFmt = '0"%"';
  updates.getColumn('note').alignment = { wrapText: true, vertical: 'top' };
  updates.getColumn('title').alignment = { wrapText: true, vertical: 'top' };
  styleHeader(updates);

  const overview = workbook.addWorksheet('事项总览');
  overview.columns = [
    { header: '负责人', key: 'member', width: 10 },
    { header: '角色', key: 'role', width: 10 },
    { header: '事项', key: 'title', width: 30 },
    { header: '项目', key: 'project', width: 16 },
    { header: '状态', key: 'status', width: 10 },
    { header: '进度', key: 'progress', width: 8 },
    { header: '优先级', key: 'priority', width: 8 },
    { header: '最近更新', key: 'last_update', width: 12 },
    { header: '距今天数', key: 'days', width: 10 },
    { header: '计划完成', key: 'due', width: 12 },
    { header: '更新次数', key: 'count', width: 10 },
    { header: '描述', key: 'description', width: 45 },
  ];
  for (const item of items) {
    overview.addRow({
      member: item.member_name,
      role: item.member_role,
      title: item.title,
      project: item.project,
      status: statusLabel(item.status),
      progress: item.progress,
      priority: priorityLabel(item.priority),
      last_update: item.last_update_date || '',
      days: item.days_since_update ?? '',
      due: item.due_date || '',
      count: item.update_count,
      description: item.description,
    });
  }
  overview.getColumn('progress').numFmt = '0"%"';
  overview.getColumn('description').alignment = { wrapText: true, vertical: 'top' };
  styleHeader(overview);

  const memberSheet = workbook.addWorksheet('成员');
  memberSheet.columns = [
    { header: '成员', key: 'name', width: 12 },
    { header: '角色', key: 'role', width: 12 },
    { header: '全部事项', key: 'item_count', width: 10 },
    { header: '活跃事项', key: 'active_count', width: 10 },
    { header: '更新记录', key: 'update_count', width: 10 },
  ];
  for (const member of members) {
    memberSheet.addRow({
      name: member.name,
      role: member.role,
      item_count: member.item_count,
      active_count: member.active_count,
      update_count: member.update_count,
    });
  }
  styleHeader(memberSheet);

  return { workbook, rows };
}


function visibilityLabel(visibility) {
  return { private: '仅自己', group: '同组可见', public: '所有登录用户' }[visibility] || visibility;
}

function reportTypeLabel(type) {
  return type === 'weekly' ? '周报' : '日报';
}

function reportDateLabel(report) {
  if (report.type !== 'weekly') return report.report_date;
  const start = db.normalizeWeekStart(report.report_date);
  return `${start} ~ ${db.addDays(start, 6)}`;
}

function buildReportsMarkdown(project, reports) {
  const lines = [`# ${mdEscape(project.name)} · 项目报告`, ''];
  lines.push(`> 组：${mdEscape(project.group_name)} · 共 ${reports.length} 份报告`, '');
  if (!reports.length) {
    lines.push('该时间范围内暂无报告。', '');
    return `${lines.join('\n').trim()}\n`;
  }
  for (const report of reports) {
    lines.push(`## ${reportDateLabel(report)} · ${reportTypeLabel(report.type)}`, '');
    lines.push(`### ${mdEscape(report.author_name)} · ${visibilityLabel(report.visibility)}`, '');
    const sections = [
      [report.type === 'weekly' ? '本周完成' : '今日完成', report.done],
      ['进行中', report.doing],
      ['问题 / 风险', report.blockers],
      [report.type === 'weekly' ? '下周计划' : '明日计划', report.next_plan],
    ];
    for (const [label, value] of sections) {
      if (!value) continue;
      lines.push(`**${label}**`, '', mdEscape(value), '');
    }
  }
  lines.push('---', `由 Team Tracker 生成 · ${formatDateTime(new Date().toISOString())}`, '');
  return `${lines.join('\n').trim()}\n`;
}

async function buildReportsWorkbook(project, reports) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Team Tracker';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('项目报告');
  sheet.columns = [
    { header: '日期 / 周期', key: 'date', width: 22 },
    { header: '类型', key: 'type', width: 8 },
    { header: '作者', key: 'author', width: 12 },
    { header: '可见性', key: 'visibility', width: 12 },
    { header: '完成内容', key: 'done', width: 36 },
    { header: '进行中', key: 'doing', width: 26 },
    { header: '问题 / 风险', key: 'blockers', width: 26 },
    { header: '下一步计划', key: 'next_plan', width: 30 },
    { header: '更新时间', key: 'updated_at', width: 20 },
  ];
  for (const report of reports) {
    sheet.addRow({
      date: reportDateLabel(report),
      type: reportTypeLabel(report.type),
      author: report.author_name,
      visibility: visibilityLabel(report.visibility),
      done: report.done,
      doing: report.doing,
      blockers: report.blockers,
      next_plan: report.next_plan,
      updated_at: formatDateTime(report.updated_at),
    });
  }
  for (const key of ['done', 'doing', 'blockers', 'next_plan']) {
    sheet.getColumn(key).alignment = { wrapText: true, vertical: 'top' };
  }
  styleHeader(sheet);

  const info = workbook.addWorksheet('项目信息');
  info.columns = [
    { header: '项目', key: 'name', width: 28 },
    { header: '组', key: 'group', width: 18 },
    { header: '描述', key: 'description', width: 50 },
    { header: '报告数', key: 'count', width: 10 },
  ];
  info.addRow({
    name: project.name,
    group: project.group_name,
    description: project.description,
    count: reports.length,
  });
  info.getColumn('description').alignment = { wrapText: true, vertical: 'top' };
  styleHeader(info);
  return workbook;
}


module.exports = { resolveRange, buildMarkdown, buildWorkbook, buildReportsMarkdown, buildReportsWorkbook };
