-- Core schema for schedules, users, roles, patterns, and events.
-- Idempotent: safe to run multiple times.
SET QUOTED_IDENTIFIER ON;

IF OBJECT_ID('dbo.Users', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Users (
        UserOid nvarchar(64) NOT NULL PRIMARY KEY,
        FullName nvarchar(200) NULL,
        DisplayName nvarchar(200) NULL,
        Email nvarchar(320) NULL,
        DefaultScheduleId int NULL,
        IsActive bit NOT NULL CONSTRAINT DF_Users_IsActive DEFAULT 1,
        CreatedAt datetime2 NOT NULL CONSTRAINT DF_Users_CreatedAt DEFAULT sysutcdatetime(),
        UpdatedAt datetime2 NULL,
        DeletedAt datetime2 NULL,
        DeletedBy nvarchar(64) NULL
    );
END;

IF COL_LENGTH('dbo.Users', 'DefaultScheduleId') IS NULL
BEGIN
    ALTER TABLE dbo.Users
    ADD DefaultScheduleId int NULL;
END;

IF COL_LENGTH('dbo.Users', 'ScheduleUiStateJson') IS NULL
BEGIN
    ALTER TABLE dbo.Users
    ADD ScheduleUiStateJson nvarchar(max) NULL;
END;

IF COL_LENGTH('dbo.Users', 'ScheduleUiStateJson') IS NOT NULL
BEGIN
    EXEC(N'
        UPDATE dbo.Users
           SET ScheduleUiStateJson = NULL
         WHERE ScheduleUiStateJson IS NOT NULL
           AND ISJSON(ScheduleUiStateJson) <> 1;
    ');
END;

IF OBJECT_ID('dbo.CK_Users_ScheduleUiStateJson_IsJson', 'C') IS NULL
BEGIN
    EXEC(N'
        ALTER TABLE dbo.Users
        ADD CONSTRAINT CK_Users_ScheduleUiStateJson_IsJson
        CHECK (ScheduleUiStateJson IS NULL OR ISJSON(ScheduleUiStateJson) = 1);
    ');
END;

IF NOT EXISTS (
    SELECT 1
    FROM sys.foreign_keys
    WHERE name = 'FK_Users_DefaultSchedule'
      AND parent_object_id = OBJECT_ID('dbo.Users')
)
AND OBJECT_ID('dbo.Schedules', 'U') IS NOT NULL
BEGIN
    ALTER TABLE dbo.Users WITH CHECK
    ADD CONSTRAINT FK_Users_DefaultSchedule FOREIGN KEY (DefaultScheduleId) REFERENCES dbo.Schedules(ScheduleId);
END;

IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = 'IX_Users_DefaultScheduleId'
      AND object_id = OBJECT_ID('dbo.Users')
)
BEGIN
    CREATE INDEX IX_Users_DefaultScheduleId ON dbo.Users (DefaultScheduleId);
END;

IF OBJECT_ID('dbo.BootstrapManagers', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.BootstrapManagers (
        UserOid nvarchar(64) NOT NULL PRIMARY KEY,
        Source nvarchar(50) NOT NULL CONSTRAINT DF_BootstrapManagers_Source DEFAULT 'env',
        GrantedAt datetime2 NOT NULL CONSTRAINT DF_BootstrapManagers_GrantedAt DEFAULT sysutcdatetime(),
        IsActive bit NOT NULL CONSTRAINT DF_BootstrapManagers_IsActive DEFAULT 1,
        DeletedAt datetime2 NULL,
        DeletedBy nvarchar(64) NULL,
        CONSTRAINT FK_BootstrapManagers_Users FOREIGN KEY (UserOid) REFERENCES dbo.Users(UserOid)
    );
END;

IF OBJECT_ID('dbo.Schedules', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Schedules (
        ScheduleId int IDENTITY(1,1) NOT NULL PRIMARY KEY,
        Name nvarchar(200) NOT NULL,
        Description nvarchar(400) NULL,
        ThemeJson nvarchar(max) NOT NULL CONSTRAINT DF_Schedules_ThemeJson DEFAULT (
            N'{"dark":{"background":"#07080b","text":"#ffffff","accent":"#c8102e","todayColor":"#c8102e","weekendColor":"#000000","weekdayColor":"#161a22","pageBorderColor":"#292a30","scheduleBorderColor":"#292a30","primaryGradient1":"#7a1b2c","primaryGradient2":"#2d1118","secondaryGradient1":"#361219","secondaryGradient2":"#0c0e12"},"light":{"background":"#f2f3f5","text":"#000000","accent":"#c8102e","todayColor":"#c8102e","weekendColor":"#d4d7de","weekdayColor":"#f5f6f8","pageBorderColor":"#bbbec6","scheduleBorderColor":"#bbbec6","primaryGradient1":"#f4d7dd","primaryGradient2":"#f8f9fb","secondaryGradient1":"#faeef0","secondaryGradient2":"#f5f6f8"}}'
        ),
        IsActive bit NOT NULL CONSTRAINT DF_Schedules_IsActive DEFAULT 1,
        CreatedAt datetime2 NOT NULL CONSTRAINT DF_Schedules_CreatedAt DEFAULT sysutcdatetime(),
        CreatedBy nvarchar(64) NULL,
        UpdatedAt datetime2 NULL,
        UpdatedBy nvarchar(64) NULL,
        DeletedAt datetime2 NULL,
        DeletedBy nvarchar(64) NULL
    );
END;

IF COL_LENGTH('dbo.Schedules', 'ThemeJson') IS NULL
BEGIN
    ALTER TABLE dbo.Schedules
    ADD ThemeJson nvarchar(max) NULL;
END;

IF OBJECT_ID('dbo.DF_Schedules_ThemeJson', 'D') IS NULL
BEGIN
    ALTER TABLE dbo.Schedules
    ADD CONSTRAINT DF_Schedules_ThemeJson
    DEFAULT (
        N'{"dark":{"background":"#07080b","text":"#ffffff","accent":"#c8102e","todayColor":"#c8102e","weekendColor":"#000000","weekdayColor":"#161a22","pageBorderColor":"#292a30","scheduleBorderColor":"#292a30","primaryGradient1":"#7a1b2c","primaryGradient2":"#2d1118","secondaryGradient1":"#361219","secondaryGradient2":"#0c0e12"},"light":{"background":"#f2f3f5","text":"#000000","accent":"#c8102e","todayColor":"#c8102e","weekendColor":"#d4d7de","weekdayColor":"#f5f6f8","pageBorderColor":"#bbbec6","scheduleBorderColor":"#bbbec6","primaryGradient1":"#f4d7dd","primaryGradient2":"#f8f9fb","secondaryGradient1":"#faeef0","secondaryGradient2":"#f5f6f8"}}'
    ) FOR ThemeJson;
END;

IF COL_LENGTH('dbo.Schedules', 'ThemeJson') IS NOT NULL
BEGIN
    EXEC(N'
        UPDATE dbo.Schedules
        SET ThemeJson = N''{"dark":{"background":"#07080b","text":"#ffffff","accent":"#c8102e","todayColor":"#c8102e","weekendColor":"#000000","weekdayColor":"#161a22","pageBorderColor":"#292a30","scheduleBorderColor":"#292a30","primaryGradient1":"#7a1b2c","primaryGradient2":"#2d1118","secondaryGradient1":"#361219","secondaryGradient2":"#0c0e12"},"light":{"background":"#f2f3f5","text":"#000000","accent":"#c8102e","todayColor":"#c8102e","weekendColor":"#d4d7de","weekdayColor":"#f5f6f8","pageBorderColor":"#bbbec6","scheduleBorderColor":"#bbbec6","primaryGradient1":"#f4d7dd","primaryGradient2":"#f8f9fb","secondaryGradient1":"#faeef0","secondaryGradient2":"#f5f6f8"}}''
        WHERE ThemeJson IS NULL
           OR ISJSON(ThemeJson) <> 1
           OR JSON_VALUE(ThemeJson, ''$.dark.background'') IS NULL
           OR JSON_VALUE(ThemeJson, ''$.dark.text'') IS NULL
           OR JSON_VALUE(ThemeJson, ''$.dark.accent'') IS NULL
           OR JSON_VALUE(ThemeJson, ''$.dark.primaryGradient1'') IS NULL
           OR JSON_VALUE(ThemeJson, ''$.dark.primaryGradient2'') IS NULL
           OR JSON_VALUE(ThemeJson, ''$.dark.secondaryGradient1'') IS NULL
           OR JSON_VALUE(ThemeJson, ''$.dark.secondaryGradient2'') IS NULL
           OR JSON_VALUE(ThemeJson, ''$.light.background'') IS NULL
           OR JSON_VALUE(ThemeJson, ''$.light.text'') IS NULL
           OR JSON_VALUE(ThemeJson, ''$.light.accent'') IS NULL
           OR JSON_VALUE(ThemeJson, ''$.light.primaryGradient1'') IS NULL
           OR JSON_VALUE(ThemeJson, ''$.light.primaryGradient2'') IS NULL
           OR JSON_VALUE(ThemeJson, ''$.light.secondaryGradient1'') IS NULL
           OR JSON_VALUE(ThemeJson, ''$.light.secondaryGradient2'') IS NULL;
    ');

    UPDATE dbo.Schedules
       SET ThemeJson =
            JSON_MODIFY(
            JSON_MODIFY(
            JSON_MODIFY(
            JSON_MODIFY(
            JSON_MODIFY(
            JSON_MODIFY(
            JSON_MODIFY(
            JSON_MODIFY(
            JSON_MODIFY(
            JSON_MODIFY(ThemeJson, '$.dark.todayColor',
                COALESCE(JSON_VALUE(ThemeJson, '$.dark.todayColor'), JSON_VALUE(ThemeJson, '$.dark.accent'), '#c8102e')),
                '$.dark.weekendColor', COALESCE(JSON_VALUE(ThemeJson, '$.dark.weekendColor'), '#000000')),
                '$.dark.weekdayColor', COALESCE(JSON_VALUE(ThemeJson, '$.dark.weekdayColor'), '#161a22')),
                '$.dark.pageBorderColor',
                COALESCE(JSON_VALUE(ThemeJson, '$.dark.pageBorderColor'), JSON_VALUE(ThemeJson, '$.dark.borderColor'), '#292a30')),
                '$.dark.scheduleBorderColor',
                COALESCE(JSON_VALUE(ThemeJson, '$.dark.scheduleBorderColor'), JSON_VALUE(ThemeJson, '$.dark.borderColor'), '#292a30')),
                '$.light.todayColor',
                COALESCE(JSON_VALUE(ThemeJson, '$.light.todayColor'), JSON_VALUE(ThemeJson, '$.light.accent'), '#c8102e')),
                '$.light.weekendColor', COALESCE(JSON_VALUE(ThemeJson, '$.light.weekendColor'), '#d4d7de')),
                '$.light.weekdayColor', COALESCE(JSON_VALUE(ThemeJson, '$.light.weekdayColor'), '#f5f6f8')),
                '$.light.pageBorderColor',
                COALESCE(JSON_VALUE(ThemeJson, '$.light.pageBorderColor'), JSON_VALUE(ThemeJson, '$.light.borderColor'), '#bbbec6')),
                '$.light.scheduleBorderColor',
                COALESCE(JSON_VALUE(ThemeJson, '$.light.scheduleBorderColor'), JSON_VALUE(ThemeJson, '$.light.borderColor'), '#bbbec6'))
     WHERE ISJSON(ThemeJson) = 1
       AND (
            JSON_VALUE(ThemeJson, '$.dark.todayColor') IS NULL
         OR JSON_VALUE(ThemeJson, '$.dark.weekendColor') IS NULL
         OR JSON_VALUE(ThemeJson, '$.dark.weekdayColor') IS NULL
         OR JSON_VALUE(ThemeJson, '$.dark.pageBorderColor') IS NULL
         OR JSON_VALUE(ThemeJson, '$.dark.scheduleBorderColor') IS NULL
         OR JSON_VALUE(ThemeJson, '$.light.todayColor') IS NULL
         OR JSON_VALUE(ThemeJson, '$.light.weekendColor') IS NULL
         OR JSON_VALUE(ThemeJson, '$.light.weekdayColor') IS NULL
         OR JSON_VALUE(ThemeJson, '$.light.pageBorderColor') IS NULL
         OR JSON_VALUE(ThemeJson, '$.light.scheduleBorderColor') IS NULL
       );
END;

IF EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.Schedules')
      AND name = 'ThemeJson'
      AND is_nullable = 1
)
BEGIN
    EXEC(N'ALTER TABLE dbo.Schedules ALTER COLUMN ThemeJson nvarchar(max) NOT NULL;');
END;

IF OBJECT_ID('dbo.CK_Schedules_ThemeJson_Valid', 'C') IS NOT NULL
BEGIN
    ALTER TABLE dbo.Schedules DROP CONSTRAINT CK_Schedules_ThemeJson_Valid;
END;

IF COL_LENGTH('dbo.Schedules', 'ThemeJson') IS NOT NULL
BEGIN
    EXEC(N'
        ALTER TABLE dbo.Schedules
        ADD CONSTRAINT CK_Schedules_ThemeJson_Valid CHECK (
            ISJSON(ThemeJson) = 1
            AND JSON_QUERY(ThemeJson, ''$.dark'') IS NOT NULL
            AND JSON_QUERY(ThemeJson, ''$.light'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.dark.background'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.dark.text'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.dark.accent'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.dark.todayColor'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.dark.weekendColor'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.dark.weekdayColor'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.dark.pageBorderColor'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.dark.scheduleBorderColor'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.dark.primaryGradient1'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.dark.primaryGradient2'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.dark.secondaryGradient1'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.dark.secondaryGradient2'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.light.background'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.light.text'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.light.accent'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.light.todayColor'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.light.weekendColor'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.light.weekdayColor'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.light.pageBorderColor'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.light.scheduleBorderColor'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.light.primaryGradient1'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.light.primaryGradient2'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.light.secondaryGradient1'') IS NOT NULL
            AND JSON_VALUE(ThemeJson, ''$.light.secondaryGradient2'') IS NOT NULL
        );
    ');
END;

IF OBJECT_ID('dbo.Roles', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Roles (
        RoleId int IDENTITY(1,1) NOT NULL PRIMARY KEY,
        RoleName nvarchar(50) NOT NULL
    );

    CREATE UNIQUE INDEX UX_Roles_RoleName ON dbo.Roles(RoleName);
END;

IF NOT EXISTS (SELECT 1 FROM dbo.Roles WHERE RoleName = 'Member')
    INSERT INTO dbo.Roles (RoleName) VALUES ('Member');
IF NOT EXISTS (SELECT 1 FROM dbo.Roles WHERE RoleName = 'Maintainer')
    INSERT INTO dbo.Roles (RoleName) VALUES ('Maintainer');
IF NOT EXISTS (SELECT 1 FROM dbo.Roles WHERE RoleName = 'Manager')
    INSERT INTO dbo.Roles (RoleName) VALUES ('Manager');

IF OBJECT_ID('dbo.Patterns', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Patterns (
        PatternId int IDENTITY(1,1) NOT NULL PRIMARY KEY,
        ScheduleId int NOT NULL,
        Name nvarchar(100) NOT NULL,
        PatternSummary nvarchar(100) NOT NULL,
        PatternJson nvarchar(max) NOT NULL,
        IsActive bit NOT NULL CONSTRAINT DF_Patterns_IsActive DEFAULT 1,
        CreatedAt datetime2 NOT NULL CONSTRAINT DF_Patterns_CreatedAt DEFAULT sysutcdatetime(),
        CreatedBy nvarchar(64) NULL,
        UpdatedAt datetime2 NULL,
        UpdatedBy nvarchar(64) NULL,
        DeletedAt datetime2 NULL,
        DeletedBy nvarchar(64) NULL,
        CONSTRAINT FK_Patterns_Schedules FOREIGN KEY (ScheduleId) REFERENCES dbo.Schedules(ScheduleId)
    );
END;

IF COL_LENGTH('dbo.Patterns', 'PatternSummary') IS NULL
BEGIN
    ALTER TABLE dbo.Patterns
    ADD PatternSummary nvarchar(100) NULL;
END;

IF COL_LENGTH('dbo.Patterns', 'PatternSummary') IS NOT NULL
BEGIN
    EXEC(N'
        UPDATE dbo.Patterns
           SET PatternSummary = ''0 shifts'';

        ;WITH SummaryCounts AS (
            SELECT
                p.PatternId,
                COUNT(*) AS ActiveShiftCount
            FROM dbo.Patterns p
            CROSS APPLY OPENJSON(p.PatternJson, ''$.swatches'')
                WITH (onDays nvarchar(max) ''$.onDays'' AS JSON) sw
            WHERE ISJSON(p.PatternJson) = 1
              AND JSON_QUERY(p.PatternJson, ''$.swatches'') IS NOT NULL
              AND EXISTS (SELECT 1 FROM OPENJSON(sw.onDays))
            GROUP BY p.PatternId
        )
        UPDATE p
           SET PatternSummary = CONCAT(
                COALESCE(sc.ActiveShiftCount, 0),
                '' '',
                CASE WHEN COALESCE(sc.ActiveShiftCount, 0) = 1 THEN ''shift'' ELSE ''shifts'' END
           )
        FROM dbo.Patterns p
        LEFT JOIN SummaryCounts sc
               ON sc.PatternId = p.PatternId;

        UPDATE dbo.Patterns
           SET PatternSummary = COALESCE(NULLIF(LTRIM(RTRIM(PatternSummary)), ''''), ''0 shifts'')
         WHERE PatternSummary IS NULL OR LTRIM(RTRIM(PatternSummary)) = '''';
    ');
END;

IF EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.Patterns')
      AND name = 'PatternSummary'
      AND is_nullable = 1
)
BEGIN
    EXEC(N'ALTER TABLE dbo.Patterns ALTER COLUMN PatternSummary nvarchar(100) NOT NULL;');
END;

IF OBJECT_ID('dbo.EmployeeTypes', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.EmployeeTypes (
        EmployeeTypeId int IDENTITY(1,1) NOT NULL PRIMARY KEY,
        ScheduleId int NOT NULL,
        Name nvarchar(50) NOT NULL,
        StartDate date NOT NULL CONSTRAINT DF_EmployeeTypes_StartDate DEFAULT CAST(SYSUTCDATETIME() AS date),
        DisplayOrder int NOT NULL CONSTRAINT DF_EmployeeTypes_DisplayOrder DEFAULT 0,
        PatternId int NULL,
        IsActive bit NOT NULL CONSTRAINT DF_EmployeeTypes_IsActive DEFAULT 1,
        CreatedAt datetime2 NOT NULL CONSTRAINT DF_EmployeeTypes_CreatedAt DEFAULT sysutcdatetime(),
        CreatedBy nvarchar(64) NULL,
        UpdatedAt datetime2 NULL,
        UpdatedBy nvarchar(64) NULL,
        DeletedAt datetime2 NULL,
        DeletedBy nvarchar(64) NULL,
        CONSTRAINT FK_EmployeeTypes_Schedules FOREIGN KEY (ScheduleId) REFERENCES dbo.Schedules(ScheduleId),
        CONSTRAINT FK_EmployeeTypes_Patterns FOREIGN KEY (PatternId) REFERENCES dbo.Patterns(PatternId)
    );
END;

IF COL_LENGTH('dbo.EmployeeTypes', 'StartDate') IS NULL
BEGIN
    ALTER TABLE dbo.EmployeeTypes
    ADD StartDate date NULL;
END;

IF OBJECT_ID('dbo.DF_EmployeeTypes_StartDate', 'D') IS NULL
BEGIN
    ALTER TABLE dbo.EmployeeTypes
    ADD CONSTRAINT DF_EmployeeTypes_StartDate
    DEFAULT CAST(SYSUTCDATETIME() AS date) FOR StartDate;
END;

IF COL_LENGTH('dbo.EmployeeTypes', 'StartDate') IS NOT NULL
BEGIN
    EXEC(N'
        UPDATE dbo.EmployeeTypes
           SET StartDate = CAST(CreatedAt AS date)
         WHERE StartDate IS NULL;
    ');
END;

IF EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.EmployeeTypes')
      AND name = 'StartDate'
      AND is_nullable = 1
)
BEGIN
    EXEC(N'ALTER TABLE dbo.EmployeeTypes ALTER COLUMN StartDate date NOT NULL;');
END;

EXEC(N'
    WITH Ordered AS (
        SELECT
            EmployeeTypeId,
            ROW_NUMBER() OVER (
                PARTITION BY ScheduleId
                ORDER BY DisplayOrder ASC, Name ASC, EmployeeTypeId ASC
            ) AS NextDisplayOrder
        FROM dbo.EmployeeTypes
        WHERE IsActive = 1
          AND DeletedAt IS NULL
    )
    UPDATE et
       SET DisplayOrder = o.NextDisplayOrder
    FROM dbo.EmployeeTypes et
    INNER JOIN Ordered o
      ON o.EmployeeTypeId = et.EmployeeTypeId
    WHERE et.DisplayOrder <> o.NextDisplayOrder;
');

IF OBJECT_ID('dbo.CK_EmployeeTypes_DisplayOrder_Positive', 'C') IS NULL
BEGIN
    ALTER TABLE dbo.EmployeeTypes
    ADD CONSTRAINT CK_EmployeeTypes_DisplayOrder_Positive CHECK (DisplayOrder >= 1);
END;

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_EmployeeTypes_Schedule_DisplayOrder_Active'
      AND object_id = OBJECT_ID('dbo.EmployeeTypes')
)
BEGIN
    CREATE INDEX IX_EmployeeTypes_Schedule_DisplayOrder_Active
    ON dbo.EmployeeTypes (ScheduleId, DisplayOrder, EmployeeTypeId)
    WHERE IsActive = 1 AND DeletedAt IS NULL;
END;

-- Pattern JSON contract:
-- {
--   "swatches": [
--     { "swatchIndex": 0, "color": "#RRGGBB", "onDays": [1, 2, ...] }
--   ],
--   "noneSwatch": { "code": "NONE" }
-- }
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Patterns') AND name = 'PatternJson')
BEGIN
    DECLARE @InvalidPatterns TABLE (PatternId int NOT NULL PRIMARY KEY);

    INSERT INTO @InvalidPatterns (PatternId)
    SELECT p.PatternId
    FROM dbo.Patterns p
    WHERE
        ISJSON(p.PatternJson) <> 1
        OR JSON_QUERY(p.PatternJson, '$.swatches') IS NULL
        OR JSON_QUERY(p.PatternJson, '$.swatches[4]') IS NOT NULL
        OR (JSON_QUERY(p.PatternJson, '$.swatches[0]') IS NOT NULL
            AND (JSON_VALUE(p.PatternJson, '$.swatches[0].color') IS NULL
                 OR JSON_QUERY(p.PatternJson, '$.swatches[0].onDays') IS NULL))
        OR (JSON_QUERY(p.PatternJson, '$.swatches[1]') IS NOT NULL
            AND (JSON_VALUE(p.PatternJson, '$.swatches[1].color') IS NULL
                 OR JSON_QUERY(p.PatternJson, '$.swatches[1].onDays') IS NULL))
        OR (JSON_QUERY(p.PatternJson, '$.swatches[2]') IS NOT NULL
            AND (JSON_VALUE(p.PatternJson, '$.swatches[2].color') IS NULL
                 OR JSON_QUERY(p.PatternJson, '$.swatches[2].onDays') IS NULL))
        OR (JSON_QUERY(p.PatternJson, '$.swatches[3]') IS NOT NULL
            AND (JSON_VALUE(p.PatternJson, '$.swatches[3].color') IS NULL
                 OR JSON_QUERY(p.PatternJson, '$.swatches[3].onDays') IS NULL))
        OR (
            JSON_VALUE(p.PatternJson, '$.noneSwatch.code') IS NOT NULL
            AND UPPER(JSON_VALUE(p.PatternJson, '$.noneSwatch.code')) <> 'NONE'
        );

    IF OBJECT_ID('dbo.EmployeeTypes', 'U') IS NOT NULL
    BEGIN
        UPDATE et
           SET PatternId = NULL,
               UpdatedAt = SYSUTCDATETIME(),
               UpdatedBy = COALESCE(et.UpdatedBy, 'schema')
        FROM dbo.EmployeeTypes et
        INNER JOIN @InvalidPatterns ip
                ON ip.PatternId = et.PatternId
        WHERE et.PatternId IS NOT NULL;
    END;

    DELETE p
    FROM dbo.Patterns p
    INNER JOIN @InvalidPatterns ip
            ON ip.PatternId = p.PatternId;

    UPDATE dbo.Patterns
       SET PatternJson = JSON_MODIFY(PatternJson, '$.noneSwatch', JSON_QUERY('{"code":"NONE"}'))
     WHERE ISJSON(PatternJson) = 1
       AND JSON_QUERY(PatternJson, '$.swatches') IS NOT NULL
       AND JSON_VALUE(PatternJson, '$.noneSwatch.code') IS NULL;
END;

IF OBJECT_ID('dbo.CK_Patterns_PatternJson_Swatches', 'C') IS NOT NULL
BEGIN
    ALTER TABLE dbo.Patterns DROP CONSTRAINT CK_Patterns_PatternJson_Swatches;
END;

ALTER TABLE dbo.Patterns
ADD CONSTRAINT CK_Patterns_PatternJson_Swatches CHECK (
    ISJSON(PatternJson) = 1
    AND JSON_QUERY(PatternJson, '$.swatches') IS NOT NULL
    AND JSON_QUERY(PatternJson, '$.swatches[4]') IS NULL
    AND (JSON_QUERY(PatternJson, '$.swatches[0]') IS NULL
         OR (JSON_VALUE(PatternJson, '$.swatches[0].color') IS NOT NULL
             AND JSON_QUERY(PatternJson, '$.swatches[0].onDays') IS NOT NULL))
    AND (JSON_QUERY(PatternJson, '$.swatches[1]') IS NULL
         OR (JSON_VALUE(PatternJson, '$.swatches[1].color') IS NOT NULL
             AND JSON_QUERY(PatternJson, '$.swatches[1].onDays') IS NOT NULL))
    AND (JSON_QUERY(PatternJson, '$.swatches[2]') IS NULL
         OR (JSON_VALUE(PatternJson, '$.swatches[2].color') IS NOT NULL
             AND JSON_QUERY(PatternJson, '$.swatches[2].onDays') IS NOT NULL))
    AND (JSON_QUERY(PatternJson, '$.swatches[3]') IS NULL
         OR (JSON_VALUE(PatternJson, '$.swatches[3].color') IS NOT NULL
             AND JSON_QUERY(PatternJson, '$.swatches[3].onDays') IS NOT NULL))
    AND (
        JSON_VALUE(PatternJson, '$.noneSwatch.code') IS NULL
        OR UPPER(JSON_VALUE(PatternJson, '$.noneSwatch.code')) = 'NONE'
    )
);

IF OBJECT_ID('dbo.CK_Patterns_Name_NotBlank', 'C') IS NULL
BEGIN
    ALTER TABLE dbo.Patterns
    ADD CONSTRAINT CK_Patterns_Name_NotBlank CHECK (LEN(LTRIM(RTRIM(Name))) > 0);
END;

IF OBJECT_ID('dbo.CK_Patterns_Summary_NotBlank', 'C') IS NULL
BEGIN
    EXEC(N'
        ALTER TABLE dbo.Patterns
        ADD CONSTRAINT CK_Patterns_Summary_NotBlank CHECK (LEN(LTRIM(RTRIM(PatternSummary))) > 0);
    ');
END;

IF COL_LENGTH('dbo.Patterns', 'PatternNameNormalized') IS NULL
BEGIN
    ALTER TABLE dbo.Patterns
    ADD PatternNameNormalized AS UPPER(LTRIM(RTRIM(Name))) PERSISTED;
END;

IF OBJECT_ID('dbo.EmployeeTypeVersions', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.EmployeeTypeVersions (
        ScheduleId int NOT NULL,
        EmployeeTypeId int NOT NULL,
        StartDate date NOT NULL,
        EndDate date NULL,
        DisplayOrder int NULL,
        Name nvarchar(50) NOT NULL,
        PatternId int NULL,
        IsActive bit NOT NULL CONSTRAINT DF_EmployeeTypeVersions_IsActive DEFAULT 1,
        CreatedAt datetime2 NOT NULL CONSTRAINT DF_EmployeeTypeVersions_CreatedAt DEFAULT sysutcdatetime(),
        CreatedBy nvarchar(64) NULL,
        UpdatedAt datetime2 NULL,
        UpdatedBy nvarchar(64) NULL,
        EndedAt datetime2 NULL,
        EndedBy nvarchar(64) NULL,
        DeletedAt datetime2 NULL,
        DeletedBy nvarchar(64) NULL,
        CONSTRAINT PK_EmployeeTypeVersions PRIMARY KEY (ScheduleId, EmployeeTypeId, StartDate),
        CONSTRAINT FK_EmployeeTypeVersions_EmployeeTypes FOREIGN KEY (EmployeeTypeId) REFERENCES dbo.EmployeeTypes(EmployeeTypeId),
        CONSTRAINT FK_EmployeeTypeVersions_Patterns FOREIGN KEY (PatternId) REFERENCES dbo.Patterns(PatternId),
        CONSTRAINT CK_EmployeeTypeVersions_DateRange CHECK (EndDate IS NULL OR EndDate >= StartDate),
        CONSTRAINT CK_EmployeeTypeVersions_Name_NotBlank CHECK (LEN(LTRIM(RTRIM(Name))) > 0)
    );
END;

IF COL_LENGTH('dbo.EmployeeTypeVersions', 'DisplayOrder') IS NULL
BEGIN
    ALTER TABLE dbo.EmployeeTypeVersions
    ADD DisplayOrder int NULL;
END;

IF COL_LENGTH('dbo.EmployeeTypeVersions', 'DisplayOrder') IS NOT NULL
BEGIN
    EXEC(N'
        UPDATE etv
           SET DisplayOrder = et.DisplayOrder
          FROM dbo.EmployeeTypeVersions etv
          INNER JOIN dbo.EmployeeTypes et
            ON et.EmployeeTypeId = etv.EmployeeTypeId
         WHERE etv.DisplayOrder IS NULL;
    ');
END;

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_EmployeeTypeVersions_Schedule_Start_End'
      AND object_id = OBJECT_ID('dbo.EmployeeTypeVersions')
)
BEGIN
    CREATE INDEX IX_EmployeeTypeVersions_Schedule_Start_End
    ON dbo.EmployeeTypeVersions (ScheduleId, StartDate, EndDate, EmployeeTypeId)
    WHERE IsActive = 1 AND DeletedAt IS NULL;
END;

IF NOT EXISTS (
    SELECT 1 FROM dbo.EmployeeTypeVersions
)
BEGIN
    IF COL_LENGTH('dbo.EmployeeTypeVersions', 'DisplayOrder') IS NOT NULL
    BEGIN
        EXEC(N'
            INSERT INTO dbo.EmployeeTypeVersions (
                ScheduleId,
                EmployeeTypeId,
                StartDate,
                EndDate,
                DisplayOrder,
                Name,
                PatternId,
                CreatedAt,
                CreatedBy,
                IsActive
            )
            SELECT
                et.ScheduleId,
                et.EmployeeTypeId,
                et.StartDate,
                NULL,
                et.DisplayOrder,
                et.Name,
                et.PatternId,
                ISNULL(et.CreatedAt, SYSUTCDATETIME()),
                et.CreatedBy,
                1
            FROM dbo.EmployeeTypes et
            WHERE et.DeletedAt IS NULL
              AND et.IsActive = 1;
        ');
    END;
    ELSE
    BEGIN
        INSERT INTO dbo.EmployeeTypeVersions (
            ScheduleId,
            EmployeeTypeId,
            StartDate,
            EndDate,
            Name,
            PatternId,
            CreatedAt,
            CreatedBy,
            IsActive
        )
        SELECT
            et.ScheduleId,
            et.EmployeeTypeId,
            et.StartDate,
            NULL,
            et.Name,
            et.PatternId,
            ISNULL(et.CreatedAt, SYSUTCDATETIME()),
            et.CreatedBy,
            1
        FROM dbo.EmployeeTypes et
        WHERE et.DeletedAt IS NULL
          AND et.IsActive = 1;
    END;
END;

IF OBJECT_ID('dbo.CoverageCodes', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.CoverageCodes (
        CoverageCodeId int IDENTITY(1,1) NOT NULL PRIMARY KEY,
        ScheduleId int NOT NULL,
        Code nvarchar(20) NOT NULL,
        Label nvarchar(100) NULL,
        DisplayMode nvarchar(30) NOT NULL CONSTRAINT DF_CoverageCodes_DisplayMode DEFAULT 'Schedule Overlay',
        Color nvarchar(20) NULL,
        SortOrder int NOT NULL CONSTRAINT DF_CoverageCodes_SortOrder DEFAULT 0,
        IsActive bit NOT NULL CONSTRAINT DF_CoverageCodes_IsActive DEFAULT 1,
        CreatedAt datetime2 NOT NULL CONSTRAINT DF_CoverageCodes_CreatedAt DEFAULT sysutcdatetime(),
        CreatedBy nvarchar(64) NULL,
        DeletedAt datetime2 NULL,
        DeletedBy nvarchar(64) NULL,
        CONSTRAINT FK_CoverageCodes_Schedules FOREIGN KEY (ScheduleId) REFERENCES dbo.Schedules(ScheduleId)
    );
END;

IF COL_LENGTH('dbo.CoverageCodes', 'DisplayMode') IS NULL
BEGIN
    ALTER TABLE dbo.CoverageCodes
    ADD DisplayMode nvarchar(30) NULL;
END;

IF COL_LENGTH('dbo.CoverageCodes', 'DisplayMode') IS NOT NULL
BEGIN
    EXEC(N'
        UPDATE dbo.CoverageCodes
           SET DisplayMode = ''Schedule Overlay''
         WHERE DisplayMode IS NULL
            OR LTRIM(RTRIM(DisplayMode)) = '''';
    ');
END;

IF OBJECT_ID('dbo.DF_CoverageCodes_DisplayMode', 'D') IS NULL
AND COL_LENGTH('dbo.CoverageCodes', 'DisplayMode') IS NOT NULL
BEGIN
    EXEC(N'
        ALTER TABLE dbo.CoverageCodes
        ADD CONSTRAINT DF_CoverageCodes_DisplayMode
        DEFAULT ''Schedule Overlay'' FOR DisplayMode;
    ');
END;

IF EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.CoverageCodes')
      AND name = 'DisplayMode'
      AND is_nullable = 1
)
BEGIN
    EXEC(N'ALTER TABLE dbo.CoverageCodes ALTER COLUMN DisplayMode nvarchar(30) NOT NULL;');
END;

IF OBJECT_ID('dbo.CK_CoverageCodes_DisplayMode', 'C') IS NULL
AND COL_LENGTH('dbo.CoverageCodes', 'DisplayMode') IS NOT NULL
BEGIN
    EXEC(N'
        ALTER TABLE dbo.CoverageCodes
        ADD CONSTRAINT CK_CoverageCodes_DisplayMode
        CHECK (DisplayMode IN (''Schedule Overlay'', ''Badge Indicator'', ''Shift Override''));
    ');
END;

IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = 'UX_CoverageCodes_Schedule_Code_Active'
      AND object_id = OBJECT_ID('dbo.CoverageCodes')
)
BEGIN
    CREATE UNIQUE INDEX UX_CoverageCodes_Schedule_Code_Active
    ON dbo.CoverageCodes (ScheduleId, Code)
    WHERE DeletedAt IS NULL;
END;

IF OBJECT_ID('dbo.ScheduleUsers', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ScheduleUsers (
        ScheduleId int NOT NULL,
        UserOid nvarchar(64) NOT NULL,
        RoleId int NOT NULL,
        GrantedAt datetime2 NOT NULL CONSTRAINT DF_ScheduleUsers_GrantedAt DEFAULT sysutcdatetime(),
        GrantedBy nvarchar(64) NULL,
        IsActive bit NOT NULL CONSTRAINT DF_ScheduleUsers_IsActive DEFAULT 1,
        DeletedAt datetime2 NULL,
        DeletedBy nvarchar(64) NULL,
        CONSTRAINT PK_ScheduleUsers PRIMARY KEY (ScheduleId, UserOid, RoleId),
        CONSTRAINT FK_ScheduleUsers_Schedules FOREIGN KEY (ScheduleId) REFERENCES dbo.Schedules(ScheduleId),
        CONSTRAINT FK_ScheduleUsers_Users FOREIGN KEY (UserOid) REFERENCES dbo.Users(UserOid),
        CONSTRAINT FK_ScheduleUsers_Roles FOREIGN KEY (RoleId) REFERENCES dbo.Roles(RoleId)
    );
END;

IF OBJECT_ID('dbo.ScheduleUserTypes', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ScheduleUserTypes (
        ScheduleId int NOT NULL,
        UserOid nvarchar(64) NOT NULL,
        EmployeeTypeId int NOT NULL,
        StartDate date NOT NULL,
        EndDate date NULL,
        DisplayOrder int NOT NULL CONSTRAINT DF_ScheduleUserTypes_DisplayOrder DEFAULT 0,
        CreatedAt datetime2 NOT NULL CONSTRAINT DF_ScheduleUserTypes_CreatedAt DEFAULT sysutcdatetime(),
        CreatedBy nvarchar(64) NULL,
        EndedAt datetime2 NULL,
        EndedBy nvarchar(64) NULL,
        IsActive bit NOT NULL CONSTRAINT DF_ScheduleUserTypes_IsActive DEFAULT 1,
        DeletedAt datetime2 NULL,
        DeletedBy nvarchar(64) NULL,
        CONSTRAINT PK_ScheduleUserTypes PRIMARY KEY (ScheduleId, UserOid, EmployeeTypeId, StartDate),
        CONSTRAINT FK_ScheduleUserTypes_Schedules FOREIGN KEY (ScheduleId) REFERENCES dbo.Schedules(ScheduleId),
        CONSTRAINT FK_ScheduleUserTypes_Users FOREIGN KEY (UserOid) REFERENCES dbo.Users(UserOid),
        CONSTRAINT FK_ScheduleUserTypes_EmployeeTypes FOREIGN KEY (EmployeeTypeId) REFERENCES dbo.EmployeeTypes(EmployeeTypeId),
        CONSTRAINT CK_ScheduleUserTypes_DateRange CHECK (EndDate IS NULL OR EndDate >= StartDate)
    );
END;

IF OBJECT_ID('dbo.ScheduleEvents', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ScheduleEvents (
        EventId int IDENTITY(1,1) NOT NULL PRIMARY KEY,
        ScheduleId int NOT NULL,
        UserOid nvarchar(64) NULL,
        EmployeeTypeId int NULL,
        StartDate date NOT NULL,
        EndDate date NOT NULL,
        CoverageCodeId int NULL,
        CustomCode nvarchar(16) NULL,
        CustomName nvarchar(100) NULL,
        CustomDisplayMode nvarchar(30) NULL,
        CustomColor nvarchar(20) NULL,
        Title nvarchar(200) NULL,
        Notes nvarchar(max) NULL,
        CreatedAt datetime2 NOT NULL CONSTRAINT DF_ScheduleEvents_CreatedAt DEFAULT sysutcdatetime(),
        CreatedBy nvarchar(64) NULL,
        IsActive bit NOT NULL CONSTRAINT DF_ScheduleEvents_IsActive DEFAULT 1,
        DeletedAt datetime2 NULL,
        DeletedBy nvarchar(64) NULL,
        CONSTRAINT FK_ScheduleEvents_Schedules FOREIGN KEY (ScheduleId) REFERENCES dbo.Schedules(ScheduleId),
        CONSTRAINT FK_ScheduleEvents_Users FOREIGN KEY (UserOid) REFERENCES dbo.Users(UserOid),
        CONSTRAINT FK_ScheduleEvents_EmployeeTypes FOREIGN KEY (EmployeeTypeId) REFERENCES dbo.EmployeeTypes(EmployeeTypeId),
        CONSTRAINT FK_ScheduleEvents_CoverageCodes FOREIGN KEY (CoverageCodeId) REFERENCES dbo.CoverageCodes(CoverageCodeId),
        CONSTRAINT CK_ScheduleEvents_DateRange CHECK (EndDate >= StartDate)
    );
END;

IF COL_LENGTH('dbo.ScheduleEvents', 'EmployeeTypeId') IS NULL
BEGIN
    ALTER TABLE dbo.ScheduleEvents
    ADD EmployeeTypeId int NULL;
END;

IF COL_LENGTH('dbo.ScheduleEvents', 'CustomCode') IS NULL
BEGIN
    ALTER TABLE dbo.ScheduleEvents
    ADD CustomCode nvarchar(16) NULL;
END;

IF COL_LENGTH('dbo.ScheduleEvents', 'CustomName') IS NULL
BEGIN
    ALTER TABLE dbo.ScheduleEvents
    ADD CustomName nvarchar(100) NULL;
END;

IF COL_LENGTH('dbo.ScheduleEvents', 'CustomDisplayMode') IS NULL
BEGIN
    ALTER TABLE dbo.ScheduleEvents
    ADD CustomDisplayMode nvarchar(30) NULL;
END;

IF COL_LENGTH('dbo.ScheduleEvents', 'CustomColor') IS NULL
BEGIN
    ALTER TABLE dbo.ScheduleEvents
    ADD CustomColor nvarchar(20) NULL;
END;

IF OBJECT_ID('dbo.FK_ScheduleEvents_EmployeeTypes', 'F') IS NULL
AND COL_LENGTH('dbo.ScheduleEvents', 'EmployeeTypeId') IS NOT NULL
BEGIN
    ALTER TABLE dbo.ScheduleEvents
    ADD CONSTRAINT FK_ScheduleEvents_EmployeeTypes
    FOREIGN KEY (EmployeeTypeId) REFERENCES dbo.EmployeeTypes(EmployeeTypeId);
END;

IF OBJECT_ID('dbo.CK_ScheduleEvents_CustomDisplayMode', 'C') IS NULL
AND COL_LENGTH('dbo.ScheduleEvents', 'CustomDisplayMode') IS NOT NULL
BEGIN
    EXEC(N'
        ALTER TABLE dbo.ScheduleEvents
        ADD CONSTRAINT CK_ScheduleEvents_CustomDisplayMode
        CHECK (
            CustomDisplayMode IS NULL
            OR CustomDisplayMode IN (''Schedule Overlay'', ''Badge Indicator'', ''Shift Override'')
        );
    ');
END;

IF OBJECT_ID('dbo.CK_ScheduleEvents_CustomColor', 'C') IS NULL
AND COL_LENGTH('dbo.ScheduleEvents', 'CustomColor') IS NOT NULL
BEGIN
    EXEC(N'
        ALTER TABLE dbo.ScheduleEvents
        ADD CONSTRAINT CK_ScheduleEvents_CustomColor
        CHECK (
            CustomColor IS NULL
            OR CustomColor LIKE ''#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]''
        );
    ');
END;

EXEC(N'
    WITH Ordered AS (
        SELECT
            ScheduleId,
            UserOid,
            EmployeeTypeId,
            StartDate,
            ROW_NUMBER() OVER (
                PARTITION BY ScheduleId
                ORDER BY DisplayOrder ASC, UserOid ASC, EmployeeTypeId ASC, StartDate ASC
            ) AS NextDisplayOrder
        FROM dbo.ScheduleUserTypes
        WHERE IsActive = 1
          AND DeletedAt IS NULL
    )
    UPDATE sut
       SET DisplayOrder = o.NextDisplayOrder
    FROM dbo.ScheduleUserTypes sut
    INNER JOIN Ordered o
      ON o.ScheduleId = sut.ScheduleId
     AND o.UserOid = sut.UserOid
     AND o.EmployeeTypeId = sut.EmployeeTypeId
     AND o.StartDate = sut.StartDate
    WHERE sut.DisplayOrder <> o.NextDisplayOrder;
');

IF OBJECT_ID('dbo.CK_ScheduleUserTypes_DisplayOrder_Positive', 'C') IS NULL
BEGIN
    ALTER TABLE dbo.ScheduleUserTypes
    ADD CONSTRAINT CK_ScheduleUserTypes_DisplayOrder_Positive CHECK (DisplayOrder >= 1);
END;

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_ScheduleUserTypes_Schedule_DisplayOrder_Active'
      AND object_id = OBJECT_ID('dbo.ScheduleUserTypes')
)
BEGIN
    CREATE INDEX IX_ScheduleUserTypes_Schedule_DisplayOrder_Active
    ON dbo.ScheduleUserTypes (ScheduleId, DisplayOrder, UserOid, EmployeeTypeId, StartDate)
    WHERE IsActive = 1 AND DeletedAt IS NULL;
END;

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes WHERE name = 'IX_ScheduleUserTypes_Range' AND object_id = OBJECT_ID('dbo.ScheduleUserTypes')
)
    CREATE INDEX IX_ScheduleUserTypes_Range
    ON dbo.ScheduleUserTypes (ScheduleId, StartDate, EndDate);

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes WHERE name = 'IX_ScheduleUserTypes_User' AND object_id = OBJECT_ID('dbo.ScheduleUserTypes')
)
    CREATE INDEX IX_ScheduleUserTypes_User
    ON dbo.ScheduleUserTypes (ScheduleId, UserOid, StartDate, EndDate);

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes WHERE name = 'IX_ScheduleEvents_Range' AND object_id = OBJECT_ID('dbo.ScheduleEvents')
)
    CREATE INDEX IX_ScheduleEvents_Range
    ON dbo.ScheduleEvents (ScheduleId, StartDate, EndDate);

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes WHERE name = 'IX_ScheduleEvents_Scope_Range' AND object_id = OBJECT_ID('dbo.ScheduleEvents')
)
    CREATE INDEX IX_ScheduleEvents_Scope_Range
    ON dbo.ScheduleEvents (ScheduleId, UserOid, EmployeeTypeId, StartDate, EndDate);

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes WHERE name = 'IX_ScheduleUsers_BySchedule' AND object_id = OBJECT_ID('dbo.ScheduleUsers')
)
    CREATE INDEX IX_ScheduleUsers_BySchedule
    ON dbo.ScheduleUsers (ScheduleId, RoleId);

IF EXISTS (
    SELECT 1 FROM sys.indexes WHERE name = 'UX_Patterns_Schedule_Name_Active' AND object_id = OBJECT_ID('dbo.Patterns')
)
    DROP INDEX UX_Patterns_Schedule_Name_Active ON dbo.Patterns;

IF EXISTS (
    SELECT 1 FROM sys.indexes WHERE name = 'UX_Patterns_Schedule_NameNorm_Active' AND object_id = OBJECT_ID('dbo.Patterns')
)
    DROP INDEX UX_Patterns_Schedule_NameNorm_Active ON dbo.Patterns;

CREATE UNIQUE INDEX UX_Patterns_Schedule_NameNorm_Active
ON dbo.Patterns (ScheduleId, PatternNameNormalized)
WHERE IsActive = 1 AND DeletedAt IS NULL;

IF OBJECT_ID('dbo.TR_ScheduleUserTypes_NoOverlap', 'TR') IS NULL
BEGIN
    EXEC('
        CREATE TRIGGER dbo.TR_ScheduleUserTypes_NoOverlap
        ON dbo.ScheduleUserTypes
        AFTER INSERT, UPDATE
        AS
        BEGIN
            SET NOCOUNT ON;

            IF EXISTS (
                SELECT 1
                FROM dbo.ScheduleUserTypes t
                JOIN inserted i
                  ON t.ScheduleId = i.ScheduleId
                 AND t.UserOid = i.UserOid
                 AND t.EmployeeTypeId = i.EmployeeTypeId
                 AND t.StartDate <> i.StartDate
                WHERE
                    t.DeletedAt IS NULL
                    AND t.IsActive = 1
                    AND i.DeletedAt IS NULL
                    AND i.IsActive = 1
                    AND t.StartDate <= ISNULL(i.EndDate, ''9999-12-31'')
                    AND ISNULL(t.EndDate, ''9999-12-31'') >= i.StartDate
            )
            BEGIN
                RAISERROR (''Overlapping ScheduleUserTypes range for this user/type.'', 16, 1);
                ROLLBACK TRANSACTION;
                RETURN;
            END
        END
    ');
END;

IF OBJECT_ID('dbo.TR_EmployeeTypeVersions_NoOverlap', 'TR') IS NULL
BEGIN
    EXEC('
        CREATE TRIGGER dbo.TR_EmployeeTypeVersions_NoOverlap
        ON dbo.EmployeeTypeVersions
        AFTER INSERT, UPDATE
        AS
        BEGIN
            SET NOCOUNT ON;

            IF EXISTS (
                SELECT 1
                FROM dbo.EmployeeTypeVersions t
                JOIN inserted i
                  ON t.ScheduleId = i.ScheduleId
                 AND t.EmployeeTypeId = i.EmployeeTypeId
                 AND t.StartDate <> i.StartDate
                WHERE
                    t.DeletedAt IS NULL
                    AND t.IsActive = 1
                    AND i.DeletedAt IS NULL
                    AND i.IsActive = 1
                    AND t.StartDate <= ISNULL(i.EndDate, ''9999-12-31'')
                    AND ISNULL(t.EndDate, ''9999-12-31'') >= i.StartDate
            )
            BEGIN
                RAISERROR (''Overlapping EmployeeTypeVersions range for this shift.'', 16, 1);
                ROLLBACK TRANSACTION;
                RETURN;
            END
        END
    ');
END;
