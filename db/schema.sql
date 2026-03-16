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
        OnboardingRole tinyint NOT NULL CONSTRAINT DF_Users_OnboardingRole DEFAULT 0,
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

IF COL_LENGTH('dbo.Users', 'OnboardingRole') IS NULL
BEGIN
    ALTER TABLE dbo.Users
    ADD OnboardingRole tinyint NULL;
END;

IF COL_LENGTH('dbo.Users', 'EntraFirstName') IS NULL
BEGIN
    ALTER TABLE dbo.Users
    ADD EntraFirstName nvarchar(100) NULL;
END;

IF COL_LENGTH('dbo.Users', 'EntraLastName') IS NULL
BEGIN
    ALTER TABLE dbo.Users
    ADD EntraLastName nvarchar(100) NULL;
END;

IF OBJECT_ID('dbo.DF_Users_OnboardingRole', 'D') IS NULL
BEGIN
    ALTER TABLE dbo.Users
    ADD CONSTRAINT DF_Users_OnboardingRole DEFAULT 0 FOR OnboardingRole;
END;

IF EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.Users')
      AND name = 'OnboardingRole'
      AND is_nullable = 1
)
BEGIN
    EXEC(N'ALTER TABLE dbo.Users ALTER COLUMN OnboardingRole tinyint NOT NULL;');
END;

IF OBJECT_ID('dbo.CK_Users_OnboardingRole_Valid', 'C') IS NULL
BEGIN
    EXEC(N'
        ALTER TABLE dbo.Users
        ADD CONSTRAINT CK_Users_OnboardingRole_Valid CHECK (OnboardingRole BETWEEN 0 AND 3);
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

IF OBJECT_ID('dbo.UserSessions', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.UserSessions (
        SessionId uniqueidentifier NOT NULL PRIMARY KEY,
        UserOid nvarchar(64) NOT NULL,
        Email nvarchar(320) NULL,
        Name nvarchar(256) NULL,
        AccessToken nvarchar(max) NOT NULL,
        RefreshToken nvarchar(max) NULL,
        ExpiresAt datetime2 NOT NULL,
        ActiveScheduleId int NULL,
        CreatedAt datetime2 NOT NULL CONSTRAINT DF_UserSessions_CreatedAt DEFAULT sysutcdatetime(),
        CONSTRAINT FK_UserSessions_Users FOREIGN KEY (UserOid) REFERENCES dbo.Users(UserOid)
    );
END;

IF COL_LENGTH('dbo.UserSessions', 'ActiveScheduleId') IS NULL
BEGIN
    ALTER TABLE dbo.UserSessions
    ADD ActiveScheduleId int NULL;
END;

IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = 'IX_UserSessions_UserOid'
      AND object_id = OBJECT_ID('dbo.UserSessions')
)
BEGIN
    CREATE INDEX IX_UserSessions_UserOid ON dbo.UserSessions(UserOid);
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

IF OBJECT_ID('dbo.CK_Schedules_ThemeJson_Valid', 'C') IS NULL
AND COL_LENGTH('dbo.Schedules', 'ThemeJson') IS NOT NULL
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

IF OBJECT_ID('dbo.Shifts', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Shifts (
        ShiftId int IDENTITY(1,1) NOT NULL PRIMARY KEY,
        ScheduleId int NOT NULL,
        Name nvarchar(50) NOT NULL,
        StartDate date NOT NULL CONSTRAINT DF_Shifts_StartDate DEFAULT CAST(SYSUTCDATETIME() AS date),
        EndDate date NULL,
        DisplayOrder int NOT NULL CONSTRAINT DF_Shifts_DisplayOrder DEFAULT 0,
        PatternId int NULL,
        IsActive bit NOT NULL CONSTRAINT DF_Shifts_IsActive DEFAULT 1,
        CreatedAt datetime2 NOT NULL CONSTRAINT DF_Shifts_CreatedAt DEFAULT sysutcdatetime(),
        CreatedBy nvarchar(64) NULL,
        UpdatedAt datetime2 NULL,
        UpdatedBy nvarchar(64) NULL,
        DeletedAt datetime2 NULL,
        DeletedBy nvarchar(64) NULL,
        CONSTRAINT FK_Shifts_Schedules FOREIGN KEY (ScheduleId) REFERENCES dbo.Schedules(ScheduleId),
        CONSTRAINT FK_Shifts_Patterns FOREIGN KEY (PatternId) REFERENCES dbo.Patterns(PatternId),
        CONSTRAINT CK_Shifts_DateRange CHECK (EndDate IS NULL OR EndDate >= StartDate)
    );
END;

IF COL_LENGTH('dbo.Shifts', 'StartDate') IS NULL
BEGIN
    ALTER TABLE dbo.Shifts
    ADD StartDate date NULL;
END;

IF COL_LENGTH('dbo.Shifts', 'EndDate') IS NULL
BEGIN
    ALTER TABLE dbo.Shifts
    ADD EndDate date NULL;
END;

IF OBJECT_ID('dbo.DF_Shifts_StartDate', 'D') IS NULL
BEGIN
    ALTER TABLE dbo.Shifts
    ADD CONSTRAINT DF_Shifts_StartDate
    DEFAULT CAST(SYSUTCDATETIME() AS date) FOR StartDate;
END;

IF EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.Shifts')
      AND name = 'StartDate'
      AND is_nullable = 1
)
BEGIN
    EXEC(N'ALTER TABLE dbo.Shifts ALTER COLUMN StartDate date NOT NULL;');
END;

IF OBJECT_ID('dbo.CK_Shifts_DateRange', 'C') IS NULL
BEGIN
    ALTER TABLE dbo.Shifts
    ADD CONSTRAINT CK_Shifts_DateRange CHECK (EndDate IS NULL OR EndDate >= StartDate);
END;

IF OBJECT_ID('dbo.CK_Shifts_DisplayOrder_Positive', 'C') IS NULL
BEGIN
    ALTER TABLE dbo.Shifts
    ADD CONSTRAINT CK_Shifts_DisplayOrder_Positive CHECK (DisplayOrder >= 1);
END;

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_Shifts_Schedule_DisplayOrder_Active'
      AND object_id = OBJECT_ID('dbo.Shifts')
)
BEGIN
    CREATE INDEX IX_Shifts_Schedule_DisplayOrder_Active
    ON dbo.Shifts (ScheduleId, DisplayOrder, ShiftId)
    WHERE IsActive = 1 AND DeletedAt IS NULL;
END;

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

IF OBJECT_ID('dbo.CK_Patterns_PatternJson_Swatches', 'C') IS NULL
BEGIN
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
END;

IF OBJECT_ID('dbo.ShiftEdits', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ShiftEdits (
        ScheduleId int NOT NULL,
        ShiftId int NOT NULL,
        StartDate date NOT NULL,
        EndDate date NULL,
        DisplayOrder int NULL,
        Name nvarchar(50) NOT NULL,
        PatternId int NULL,
        IsActive bit NOT NULL CONSTRAINT DF_ShiftEdits_IsActive DEFAULT 1,
        CreatedAt datetime2 NOT NULL CONSTRAINT DF_ShiftEdits_CreatedAt DEFAULT sysutcdatetime(),
        CreatedBy nvarchar(64) NULL,
        UpdatedAt datetime2 NULL,
        UpdatedBy nvarchar(64) NULL,
        EndedAt datetime2 NULL,
        EndedBy nvarchar(64) NULL,
        DeletedAt datetime2 NULL,
        DeletedBy nvarchar(64) NULL,
        CONSTRAINT PK_ShiftEdits PRIMARY KEY (ScheduleId, ShiftId, StartDate),
        CONSTRAINT FK_ShiftEdits_Shifts FOREIGN KEY (ShiftId) REFERENCES dbo.Shifts(ShiftId),
        CONSTRAINT FK_ShiftEdits_Patterns FOREIGN KEY (PatternId) REFERENCES dbo.Patterns(PatternId),
        CONSTRAINT CK_ShiftEdits_DateRange CHECK (EndDate IS NULL OR EndDate >= StartDate),
        CONSTRAINT CK_ShiftEdits_Name_NotBlank CHECK (LEN(LTRIM(RTRIM(Name))) > 0)
    );
END;

IF COL_LENGTH('dbo.ShiftEdits', 'DisplayOrder') IS NULL
BEGIN
    ALTER TABLE dbo.ShiftEdits
    ADD DisplayOrder int NULL;
END;

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_ShiftEdits_Schedule_Start_End'
      AND object_id = OBJECT_ID('dbo.ShiftEdits')
)
BEGIN
    CREATE INDEX IX_ShiftEdits_Schedule_Start_End
    ON dbo.ShiftEdits (ScheduleId, StartDate, EndDate, ShiftId)
    WHERE IsActive = 1 AND DeletedAt IS NULL;
END;

IF OBJECT_ID('dbo.ScheduleShiftOrders', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ScheduleShiftOrders (
        ScheduleId int NOT NULL,
        EffectiveMonth date NOT NULL,
        ShiftId int NOT NULL,
        DisplayOrder int NOT NULL,
        CreatedAt datetime2 NOT NULL CONSTRAINT DF_ScheduleShiftOrders_CreatedAt DEFAULT sysutcdatetime(),
        CreatedBy nvarchar(64) NULL,
        UpdatedAt datetime2 NULL,
        UpdatedBy nvarchar(64) NULL,
        CONSTRAINT PK_ScheduleShiftOrders PRIMARY KEY (ScheduleId, EffectiveMonth, ShiftId),
        CONSTRAINT FK_ScheduleShiftOrders_Schedules FOREIGN KEY (ScheduleId) REFERENCES dbo.Schedules(ScheduleId),
        CONSTRAINT FK_ScheduleShiftOrders_Shifts FOREIGN KEY (ShiftId)
            REFERENCES dbo.Shifts(ShiftId),
        CONSTRAINT CK_ScheduleShiftOrders_MonthStart CHECK (DAY(EffectiveMonth) = 1),
        CONSTRAINT CK_ScheduleShiftOrders_DisplayOrder CHECK (DisplayOrder >= 1)
    );
END;

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'UX_ScheduleShiftOrders_ScheduleMonth_Order'
      AND object_id = OBJECT_ID('dbo.ScheduleShiftOrders')
)
BEGIN
    CREATE UNIQUE INDEX UX_ScheduleShiftOrders_ScheduleMonth_Order
    ON dbo.ScheduleShiftOrders (ScheduleId, EffectiveMonth, DisplayOrder);
END;

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_ScheduleShiftOrders_Schedule_EffectiveMonth'
      AND object_id = OBJECT_ID('dbo.ScheduleShiftOrders')
)
BEGIN
    CREATE INDEX IX_ScheduleShiftOrders_Schedule_EffectiveMonth
    ON dbo.ScheduleShiftOrders (ScheduleId, EffectiveMonth DESC);
END;

IF OBJECT_ID('dbo.ScheduleAssignmentOrders', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ScheduleAssignmentOrders (
        ScheduleId int NOT NULL,
        EffectiveMonth date NOT NULL,
        ShiftId int NOT NULL,
        UserOid nvarchar(64) NOT NULL,
        DisplayOrder int NOT NULL,
        CreatedAt datetime2 NOT NULL CONSTRAINT DF_ScheduleAssignmentOrders_CreatedAt DEFAULT sysutcdatetime(),
        CreatedBy nvarchar(64) NULL,
        UpdatedAt datetime2 NULL,
        UpdatedBy nvarchar(64) NULL,
        CONSTRAINT PK_ScheduleAssignmentOrders PRIMARY KEY (ScheduleId, EffectiveMonth, ShiftId, UserOid),
        CONSTRAINT FK_ScheduleAssignmentOrders_Schedules FOREIGN KEY (ScheduleId) REFERENCES dbo.Schedules(ScheduleId),
        CONSTRAINT FK_ScheduleAssignmentOrders_Shifts FOREIGN KEY (ShiftId) REFERENCES dbo.Shifts(ShiftId),
        CONSTRAINT FK_ScheduleAssignmentOrders_Users FOREIGN KEY (UserOid) REFERENCES dbo.Users(UserOid),
        CONSTRAINT CK_ScheduleAssignmentOrders_MonthStart CHECK (DAY(EffectiveMonth) = 1),
        CONSTRAINT CK_ScheduleAssignmentOrders_DisplayOrder CHECK (DisplayOrder >= 1)
    );
END;

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'UX_ScheduleAssignmentOrders_ScheduleMonthShift_Order'
      AND object_id = OBJECT_ID('dbo.ScheduleAssignmentOrders')
)
BEGIN
    CREATE UNIQUE INDEX UX_ScheduleAssignmentOrders_ScheduleMonthShift_Order
    ON dbo.ScheduleAssignmentOrders (ScheduleId, EffectiveMonth, ShiftId, DisplayOrder);
END;

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_ScheduleAssignmentOrders_Schedule_Month'
      AND object_id = OBJECT_ID('dbo.ScheduleAssignmentOrders')
)
BEGIN
    CREATE INDEX IX_ScheduleAssignmentOrders_Schedule_Month
    ON dbo.ScheduleAssignmentOrders (ScheduleId, EffectiveMonth DESC, ShiftId, DisplayOrder);
END;

IF OBJECT_ID('dbo.EventCodes', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.EventCodes (
        EventCodeId int IDENTITY(1,1) NOT NULL PRIMARY KEY,
        ScheduleId int NOT NULL,
        Code nvarchar(20) NOT NULL,
        Label nvarchar(100) NULL,
        DisplayMode nvarchar(30) NOT NULL CONSTRAINT DF_EventCodes_DisplayMode DEFAULT 'Schedule Overlay',
        Color nvarchar(20) NULL,
        SortOrder int NOT NULL CONSTRAINT DF_EventCodes_SortOrder DEFAULT 0,
        IsActive bit NOT NULL CONSTRAINT DF_EventCodes_IsActive DEFAULT 1,
        CreatedAt datetime2 NOT NULL CONSTRAINT DF_EventCodes_CreatedAt DEFAULT sysutcdatetime(),
        CreatedBy nvarchar(64) NULL,
        UpdatedAt datetime2 NULL,
        UpdatedBy nvarchar(64) NULL,
        DeletedAt datetime2 NULL,
        DeletedBy nvarchar(64) NULL,
        CONSTRAINT FK_EventCodes_Schedules FOREIGN KEY (ScheduleId) REFERENCES dbo.Schedules(ScheduleId)
    );
END;

IF COL_LENGTH('dbo.EventCodes', 'DisplayMode') IS NULL
BEGIN
    ALTER TABLE dbo.EventCodes
    ADD DisplayMode nvarchar(30) NULL;
END;

IF OBJECT_ID('dbo.DF_EventCodes_DisplayMode', 'D') IS NULL
AND COL_LENGTH('dbo.EventCodes', 'DisplayMode') IS NOT NULL
BEGIN
    EXEC(N'
        ALTER TABLE dbo.EventCodes
        ADD CONSTRAINT DF_EventCodes_DisplayMode
        DEFAULT ''Schedule Overlay'' FOR DisplayMode;
    ');
END;

IF EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.EventCodes')
      AND name = 'DisplayMode'
      AND is_nullable = 1
)
BEGIN
    EXEC(N'ALTER TABLE dbo.EventCodes ALTER COLUMN DisplayMode nvarchar(30) NOT NULL;');
END;

IF OBJECT_ID('dbo.CK_EventCodes_DisplayMode', 'C') IS NULL
AND COL_LENGTH('dbo.EventCodes', 'DisplayMode') IS NOT NULL
BEGIN
    EXEC(N'
        ALTER TABLE dbo.EventCodes
        ADD CONSTRAINT CK_EventCodes_DisplayMode
        CHECK (DisplayMode IN (''Schedule Overlay'', ''Badge Indicator'', ''Shift Override''));
    ');
END;

IF COL_LENGTH('dbo.EventCodes', 'UpdatedAt') IS NULL
BEGIN
    ALTER TABLE dbo.EventCodes
    ADD UpdatedAt datetime2 NULL;
END;

IF COL_LENGTH('dbo.EventCodes', 'UpdatedBy') IS NULL
BEGIN
    ALTER TABLE dbo.EventCodes
    ADD UpdatedBy nvarchar(64) NULL;
END;

IF COL_LENGTH('dbo.EventCodes', 'NotifyImmediately') IS NULL
BEGIN
    ALTER TABLE dbo.EventCodes
    ADD NotifyImmediately bit NOT NULL
        CONSTRAINT DF_EventCodes_NotifyImmediately DEFAULT 0;
END;

IF COL_LENGTH('dbo.EventCodes', 'ScheduledRemindersJson') IS NULL
BEGIN
    ALTER TABLE dbo.EventCodes
    ADD ScheduledRemindersJson nvarchar(max) NULL;
END;

IF OBJECT_ID('dbo.CK_EventCodes_ScheduledRemindersJson_IsJson', 'C') IS NULL
AND COL_LENGTH('dbo.EventCodes', 'ScheduledRemindersJson') IS NOT NULL
BEGIN
    EXEC(N'
        ALTER TABLE dbo.EventCodes
        ADD CONSTRAINT CK_EventCodes_ScheduledRemindersJson_IsJson
        CHECK (
            ScheduledRemindersJson IS NULL
            OR ISJSON(ScheduledRemindersJson) = 1
            OR LTRIM(RTRIM(ScheduledRemindersJson)) = ''''
        );
    ');
END;

IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = 'UX_EventCodes_Schedule_Code_Active'
      AND object_id = OBJECT_ID('dbo.EventCodes')
)
BEGIN
    CREATE UNIQUE INDEX UX_EventCodes_Schedule_Code_Active
    ON dbo.EventCodes (ScheduleId, Code)
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

IF OBJECT_ID('dbo.ScheduleAssignments', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ScheduleAssignments (
        ScheduleId int NOT NULL,
        UserOid nvarchar(64) NOT NULL,
        ShiftId int NOT NULL,
        StartDate date NOT NULL,
        EndDate date NULL,
        CreatedAt datetime2 NOT NULL CONSTRAINT DF_ScheduleAssignments_CreatedAt DEFAULT sysutcdatetime(),
        CreatedBy nvarchar(64) NULL,
        EndedAt datetime2 NULL,
        EndedBy nvarchar(64) NULL,
        IsActive bit NOT NULL CONSTRAINT DF_ScheduleAssignments_IsActive DEFAULT 1,
        DeletedAt datetime2 NULL,
        DeletedBy nvarchar(64) NULL,
        CONSTRAINT PK_ScheduleAssignments PRIMARY KEY (ScheduleId, UserOid, ShiftId, StartDate),
        CONSTRAINT FK_ScheduleAssignments_Schedules FOREIGN KEY (ScheduleId) REFERENCES dbo.Schedules(ScheduleId),
        CONSTRAINT FK_ScheduleAssignments_Users FOREIGN KEY (UserOid) REFERENCES dbo.Users(UserOid),
        CONSTRAINT FK_ScheduleAssignments_Shifts FOREIGN KEY (ShiftId) REFERENCES dbo.Shifts(ShiftId),
        CONSTRAINT CK_ScheduleAssignments_DateRange CHECK (EndDate IS NULL OR EndDate >= StartDate)
    );
END;

IF OBJECT_ID('dbo.ScheduleEvents', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ScheduleEvents (
        EventId int IDENTITY(1,1) NOT NULL PRIMARY KEY,
        ScheduleId int NOT NULL,
        UserOid nvarchar(64) NULL,
        ShiftId int NULL,
        StartDate date NOT NULL,
        EndDate date NOT NULL,
        EventCodeId int NULL,
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
        CONSTRAINT FK_ScheduleEvents_Shifts FOREIGN KEY (ShiftId) REFERENCES dbo.Shifts(ShiftId),
        CONSTRAINT FK_ScheduleEvents_EventCodes FOREIGN KEY (EventCodeId) REFERENCES dbo.EventCodes(EventCodeId),
        CONSTRAINT CK_ScheduleEvents_DateRange CHECK (EndDate >= StartDate)
    );
END;

IF COL_LENGTH('dbo.ScheduleEvents', 'ShiftId') IS NULL
BEGIN
    ALTER TABLE dbo.ScheduleEvents
    ADD ShiftId int NULL;
END;

IF COL_LENGTH('dbo.ScheduleEvents', 'EventCodeId') IS NULL
BEGIN
    ALTER TABLE dbo.ScheduleEvents
    ADD EventCodeId int NULL;
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

IF COL_LENGTH('dbo.ScheduleEvents', 'ScheduledRemindersJson') IS NULL
BEGIN
    ALTER TABLE dbo.ScheduleEvents
    ADD ScheduledRemindersJson nvarchar(max) NULL;
END;

IF COL_LENGTH('dbo.ScheduleEvents', 'ReminderDispatchStateJson') IS NULL
BEGIN
    ALTER TABLE dbo.ScheduleEvents
    ADD ReminderDispatchStateJson nvarchar(max) NULL;
END;

IF OBJECT_ID('dbo.CK_ScheduleEvents_ScheduledRemindersJson_IsJson', 'C') IS NULL
AND COL_LENGTH('dbo.ScheduleEvents', 'ScheduledRemindersJson') IS NOT NULL
BEGIN
    EXEC(N'
        ALTER TABLE dbo.ScheduleEvents
        ADD CONSTRAINT CK_ScheduleEvents_ScheduledRemindersJson_IsJson
        CHECK (
            ScheduledRemindersJson IS NULL
            OR ISJSON(ScheduledRemindersJson) = 1
            OR LTRIM(RTRIM(ScheduledRemindersJson)) = ''''
        );
    ');
END;

IF OBJECT_ID('dbo.CK_ScheduleEvents_ReminderDispatchStateJson_IsJson', 'C') IS NULL
AND COL_LENGTH('dbo.ScheduleEvents', 'ReminderDispatchStateJson') IS NOT NULL
BEGIN
    EXEC(N'
        ALTER TABLE dbo.ScheduleEvents
        ADD CONSTRAINT CK_ScheduleEvents_ReminderDispatchStateJson_IsJson
        CHECK (
            ReminderDispatchStateJson IS NULL
            OR ISJSON(ReminderDispatchStateJson) = 1
            OR LTRIM(RTRIM(ReminderDispatchStateJson)) = ''''
        );
    ');
END;

IF OBJECT_ID('dbo.FK_ScheduleEvents_Shifts', 'F') IS NULL
AND COL_LENGTH('dbo.ScheduleEvents', 'ShiftId') IS NOT NULL
BEGIN
    ALTER TABLE dbo.ScheduleEvents
    ADD CONSTRAINT FK_ScheduleEvents_Shifts
    FOREIGN KEY (ShiftId) REFERENCES dbo.Shifts(ShiftId);
END;

IF OBJECT_ID('dbo.FK_ScheduleEvents_EventCodes', 'F') IS NULL
AND COL_LENGTH('dbo.ScheduleEvents', 'EventCodeId') IS NOT NULL
BEGIN
    ALTER TABLE dbo.ScheduleEvents
    ADD CONSTRAINT FK_ScheduleEvents_EventCodes
    FOREIGN KEY (EventCodeId) REFERENCES dbo.EventCodes(EventCodeId);
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

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes WHERE name = 'IX_ScheduleAssignments_Range' AND object_id = OBJECT_ID('dbo.ScheduleAssignments')
)
    CREATE INDEX IX_ScheduleAssignments_Range
    ON dbo.ScheduleAssignments (ScheduleId, StartDate, EndDate);

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes WHERE name = 'IX_ScheduleAssignments_User' AND object_id = OBJECT_ID('dbo.ScheduleAssignments')
)
    CREATE INDEX IX_ScheduleAssignments_User
    ON dbo.ScheduleAssignments (ScheduleId, UserOid, StartDate, EndDate);

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes WHERE name = 'IX_ScheduleEvents_Range' AND object_id = OBJECT_ID('dbo.ScheduleEvents')
)
    CREATE INDEX IX_ScheduleEvents_Range
    ON dbo.ScheduleEvents (ScheduleId, StartDate, EndDate);

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes WHERE name = 'IX_ScheduleEvents_Scope_Range' AND object_id = OBJECT_ID('dbo.ScheduleEvents')
)
    CREATE INDEX IX_ScheduleEvents_Scope_Range
    ON dbo.ScheduleEvents (ScheduleId, UserOid, ShiftId, StartDate, EndDate);

IF OBJECT_ID('dbo.ScheduleEventReminderDispatchLog', 'U') IS NOT NULL
BEGIN
    DROP TABLE dbo.ScheduleEventReminderDispatchLog;
END;

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

IF OBJECT_ID('dbo.TR_ScheduleAssignments_NoOverlap', 'TR') IS NULL
BEGIN
    EXEC('
        CREATE TRIGGER dbo.TR_ScheduleAssignments_NoOverlap
        ON dbo.ScheduleAssignments
        AFTER INSERT, UPDATE
        AS
        BEGIN
            SET NOCOUNT ON;

            IF EXISTS (
                SELECT 1
                FROM dbo.ScheduleAssignments t
                JOIN inserted i
                  ON t.ScheduleId = i.ScheduleId
                 AND t.UserOid = i.UserOid
                 AND t.ShiftId = i.ShiftId
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
                RAISERROR (''Overlapping ScheduleAssignments range for this user/type.'', 16, 1);
                ROLLBACK TRANSACTION;
                RETURN;
            END
        END
    ');
END;

IF OBJECT_ID('dbo.TR_ShiftEdits_NoOverlap', 'TR') IS NULL
BEGIN
    EXEC('
        CREATE TRIGGER dbo.TR_ShiftEdits_NoOverlap
        ON dbo.ShiftEdits
        AFTER INSERT, UPDATE
        AS
        BEGIN
            SET NOCOUNT ON;

            IF EXISTS (
                SELECT 1
                FROM dbo.ShiftEdits t
                JOIN inserted i
                  ON t.ScheduleId = i.ScheduleId
                 AND t.ShiftId = i.ShiftId
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
                RAISERROR (''Overlapping ShiftEdits range for this shift.'', 16, 1);
                ROLLBACK TRANSACTION;
                RETURN;
            END
        END
    ');
END;
