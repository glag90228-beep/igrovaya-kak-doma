'use strict';

// Построитель SQL запросов для безопасности и переиспользования
class QueryBuilder {
  constructor() {
    this.select = [];
    this.from = '';
    this.joins = [];
    this.wheres = [];
    this.params = [];
    this.groupBy = [];
    this.orderBy = [];
    this.limitValue = null;
    this.offsetValue = null;
  }

  selectFields(...fields) {
    this.select = fields.length > 0 ? fields : ['*'];
    return this;
  }

  table(tableName) {
    this.from = tableName;
    return this;
  }

  join(joinType, table, condition) {
    this.joins.push(`${joinType} JOIN ${table} ON ${condition}`);
    return this;
  }

  innerJoin(table, condition) {
    return this.join('INNER', table, condition);
  }

  leftJoin(table, condition) {
    return this.join('LEFT', table, condition);
  }

  where(condition, ...values) {
    this.wheres.push(condition);
    this.params.push(...values);
    return this;
  }

  andWhere(condition, ...values) {
    if (this.wheres.length > 0) {
      this.wheres.push('AND ' + condition);
    } else {
      this.wheres.push(condition);
    }
    this.params.push(...values);
    return this;
  }

  orWhere(condition, ...values) {
    if (this.wheres.length > 0) {
      this.wheres.push('OR ' + condition);
    } else {
      this.wheres.push(condition);
    }
    this.params.push(...values);
    return this;
  }

  groupByFields(...fields) {
    this.groupBy = fields;
    return this;
  }

  orderByField(field, direction = 'ASC') {
    this.orderBy.push(`${field} ${direction.toUpperCase()}`);
    return this;
  }

  limit(value) {
    this.limitValue = value;
    return this;
  }

  offset(value) {
    this.offsetValue = value;
    return this;
  }

  build() {
    let sql = 'SELECT ' + (this.select.length > 0 ? this.select.join(', ') : '*');

    sql += ` FROM ${this.from}`;

    if (this.joins.length > 0) {
      sql += ' ' + this.joins.join(' ');
    }

    if (this.wheres.length > 0) {
      sql += ' WHERE ' + this.wheres.join(' ');
    }

    if (this.groupBy.length > 0) {
      sql += ' GROUP BY ' + this.groupBy.join(', ');
    }

    if (this.orderBy.length > 0) {
      sql += ' ORDER BY ' + this.orderBy.join(', ');
    }

    if (this.limitValue !== null) {
      sql += ` LIMIT ${this.limitValue}`;
    }

    if (this.offsetValue !== null) {
      sql += ` OFFSET ${this.offsetValue}`;
    }

    return { sql, params: this.params };
  }

  buildInsert(table, data) {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map(() => '?').join(', ');

    const sql = `INSERT INTO ${table}(${keys.join(', ')}) VALUES(${placeholders})`;

    return { sql, params: values };
  }

  buildUpdate(table, data, whereCondition, whereParams = []) {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const updates = keys.map(k => `${k} = ?`).join(', ');

    const sql = `UPDATE ${table} SET ${updates} WHERE ${whereCondition}`;

    return { sql, params: [...values, ...whereParams] };
  }

  buildDelete(table, whereCondition, whereParams = []) {
    const sql = `DELETE FROM ${table} WHERE ${whereCondition}`;

    return { sql, params: whereParams };
  }

  buildCount(tableName) {
    let sql = 'SELECT COUNT(*) as count FROM ' + tableName;

    if (this.joins.length > 0) {
      sql += ' ' + this.joins.join(' ');
    }

    if (this.wheres.length > 0) {
      sql += ' WHERE ' + this.wheres.join(' ');
    }

    return { sql, params: this.params };
  }
}

// Фильтры для частых запросов
function dateRange(field, startDate, endDate) {
  return {
    condition: `${field} BETWEEN ? AND ?`,
    params: [startDate, endDate],
  };
}

function inList(field, values) {
  const placeholders = values.map(() => '?').join(', ');
  return {
    condition: `${field} IN (${placeholders})`,
    params: values,
  };
}

function like(field, value) {
  return {
    condition: `${field} LIKE ?`,
    params: [`%${value}%`],
  };
}

module.exports = {
  QueryBuilder,
  dateRange,
  inList,
  like,
};
