/*
**  IPC-KeyVal -- Inter-Process-Communication Key-Value Store
**  Copyright (c) 2017-2018 Ralf S. Engelschall <rse@engelschall.com>
**
**  Permission is hereby granted, free of charge, to any person obtaining
**  a copy of this software and associated documentation files (the
**  "Software"), to deal in the Software without restriction, including
**  without limitation the rights to use, copy, modify, merge, publish,
**  distribute, sublicense, and/or sell copies of the Software, and to
**  permit persons to whom the Software is furnished to do so, subject to
**  the following conditions:
**
**  The above copyright notice and this permission notice shall be included
**  in all copies or substantial portions of the Software.
**
**  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
**  EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
**  MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
**  IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
**  CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
**  TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
**  SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

import fs       from "fs"
import mysql    from "mysql"
import { Lock } from "lock"

/*  Key-Value for Remote-Process-Model (RPM) with MySQL/MariaDB standalone database  */
export default class KeyVal {
    constructor (url) {
        this.url    = url
        this.opened = false
        this.lock   = Lock()
        this.locked = false
        this.unlock = null
        this.options = {
            database: null,
            table:    "KeyVal",
            colKey:   "name", /* "key" is a reserved word in MySQL! */
            colVal:   "val"
        }
        if (this.url.pathname)
            this.options.database = this.url.pathname.replace(/^\//, "")
        else
            throw new Error("require path in URL")
        Object.keys(this.options).forEach((name) => {
            if (this.url.query[name] !== undefined)
                this.options[name] = this.url.query[name]
        })
    }

    /*  open connection  */
    async open () {
        if (this.opened)
            throw new Error("already opened")
        let config = {
            database: this.options.database,
            host: this.url.hostname,
            port: this.url.port ? parseInt(this.url.port) : 3306
        }
        if (this.url.auth) {
            config.user     = this.url.auth.split(":")[0]
            config.password = this.url.auth.split(":")[1]
        }
        if (   this.url.query.tls !== undefined
            || this.url.query.ca  !== undefined
            || this.url.query.key !== undefined
            || this.url.query.crt !== undefined) {
            config.ssl = { rejectUnauthorized: false }
            if (this.url.query.ca !== undefined) {
                config.ssl.ca = fs.readFileSync(this.url.query.ca).toString()
                config.ssl.rejectUnauthorized = true
            }
            if (this.url.query.key !== undefined)
                config.ssl.key = fs.readFileSync(this.url.query.key).toString()
            if (this.url.query.crt !== undefined)
                config.ssl.cert = fs.readFileSync(this.url.query.crt).toString()
        }
        await new Promise((resolve, reject) => {
            this.db = mysql.createConnection(config)
            this.db.connect((err) => {
                if (err) reject(err)
                else     resolve()
            })
        })
        return new Promise((resolve, reject) => {
            this.db.query(`CREATE TABLE IF NOT EXISTS ${this.options.table} ` +
                `(${this.options.colKey} VARCHAR(128), ` +
                `${this.options.colVal} TEXT, ` +
                `PRIMARY KEY (${this.options.colKey}));`, [],
                (err) => {
                    if (err)
                        reject(err)
                    else {
                        this.opened = true
                        resolve()
                    }
                }
            )
        })
    }

    /*  retrieve all keys  */
    async keys (pattern) {
        if (!this.opened)
            throw new Error("still not opened")
        return new Promise((resolve, reject) => {
            let sql = `SELECT ${this.options.colKey} FROM ${this.options.table}`
            if (typeof pattern === "string") {
                pattern = `^${pattern.replace(/([.?{}])/g, "\\$1").replace(/\*/g, ".+").replace(/'/g, "''")}$`
                sql += ` WHERE ${this.options.colKey} REGEXP '${pattern}'`
            }
            sql += ";"
            this.db.query(sql, [],
                (err, result) => {
                    if (err)
                        reject(err)
                    else {
                        let keys = result.map((row) => row[this.options.colKey])
                        resolve(keys)
                    }
                }
            )
        })
    }

    /*  put value under key into store  */
    async put (key, value) {
        if (!this.opened)
            throw new Error("still not opened")
        return new Promise((resolve, reject) => {
            let val = JSON.stringify(value)
            this.db.query(`INSERT INTO ${this.options.table} ` +
                `(${this.options.colKey}, ${this.options.colVal}) VALUES (?, ?) ` +
                `ON DUPLICATE KEY UPDATE ${this.options.colVal} = ?;`,
                [ key, val, val ],
                (err) => {
                    if (err) reject(err)
                    else     resolve()
                }
            )
        })
    }

    /*  get value under key from store  */
    async get (key) {
        if (!this.opened)
            throw new Error("still not opened")
        return new Promise((resolve, reject) => {
            this.db.query(`SELECT ${this.options.colVal} FROM ${this.options.table} ` +
                `WHERE ${this.options.colKey} = ?;`,
                [ key ],
                (err, result) => {
                    if (err)
                        reject(err)
                    else {
                        let value
                        if (result.length === 1)
                            value = JSON.parse(result[0][this.options.colVal])
                        resolve(value)
                    }
                }
            )
        })
    }

    /*  delete value under key from store  */
    async del (key) {
        if (!this.opened)
            throw new Error("still not opened")
        return new Promise((resolve, reject) => {
            this.db.query(`DELETE FROM ${this.options.table} ` +
                `WHERE ${this.options.colKey} = ?;`,
                [ key ],
                (err) => {
                    if (err) reject(err)
                    else     resolve()
                }
            )
        })
    }

    /*  acquire mutual exclusion lock  */
    async acquire () {
        if (!this.opened)
            throw new Error("still not opened")
        return new Promise((resolve, reject) => {
            this.lock("IPC-KeyVal-rpm", (unlock) => {
                this.unlock = unlock
                this.locked = true
                this.db.query("START TRANSACTION;", [],
                    (err) => {
                        if (err) reject(err)
                        else     resolve()
                    }
                )
            })
        })
    }

    /*  release mutual exclusion lock  */
    async release () {
        if (!this.opened)
            throw new Error("still not opened")
        if (!this.locked)
            throw new Error("still not acquired")
        return new Promise((resolve, reject) => {
            this.db.query("COMMIT;", [],
                (err) => {
                    if (err) reject(err)
                    else {
                        this.unlock((err) => {
                            if (err)
                                reject(err)
                            else {
                                this.unlock = null
                                this.locked = false
                                resolve()
                            }
                        })()
                    }
                }
            )
        })
    }

    /*  close connection  */
    async close () {
        if (!this.opened)
            throw new Error("still not opened")
        if (this.locked)
            await this.release()
        return new Promise((resolve, reject) => {
            this.db.end((err) => {
                if (err)
                    reject(err)
                else {
                    delete this.db
                    this.opened = false
                    resolve()
                }
            })
        })
    }
}

